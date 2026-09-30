import { AppDataSource } from "../database/dataSource.js";
import { Role } from "../entities/Role.js";
import { ScoutCandidate } from "../entities/ScoutCandidate.js";
import { User } from "../entities/User.js";
import { NotFoundError, ValidationError } from "../utils/errors";
import { ExperienceLevel, UserRole, WorkMode } from "../types/enums.js";
import { createEmbedding, assessTalentFit } from "../utils/integrations/openai.js";
import { convertSimilarityToPercentage, preprocessText } from "../utils/text.js";
import logger from "../utils/logger.js";

const userRepo = () => AppDataSource.getRepository(User);
const candidateRepo = () => AppDataSource.getRepository(ScoutCandidate);
const roleRepo = () => AppDataSource.getRepository(Role);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export interface TalentSearchParams {
  description: string;
  roleId?: string | null;
  experienceLevel?: ExperienceLevel | null;
  workMode?: WorkMode | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  limit?: number;
  offset?: number;
}

/** Either a talent who signed up, or a candidate sourced from a scouted CV. */
export type TalentSearchSource = "registered" | "sourced";

export interface TalentSearchResult {
  id: string;
  source: TalentSearchSource;
  name: string;
  headline: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  skills: string[];
  yearsExperience: number | null;
  experienceLevel: string | null;
  matchScore: number;
  strengths?: string[];
  weaknesses?: string[];
  /** Registered talents can be messaged in-app; sourced candidates have no account yet. */
  canMessage: boolean;
}

interface RankedRow {
  id: string;
  source: TalentSearchSource;
  similarity: number;
}

/**
 * Ranks both talent pools against one embedded description.
 *
 * Registered talents have many CV chunks, so each is reduced to their single best
 * chunk. Sourced candidates hold one vector each. `<=>` is cosine *distance*, so
 * smaller is better and every ordering here is ASC.
 */
const rankBothPools = async (
  vector: string,
  limit: number,
  offset: number,
  filters: TalentSearchParams
): Promise<{ rows: RankedRow[]; total: number }> => {
  const conditions: string[] = [];
  const params: unknown[] = [vector];

  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  // Hard filters are applied per-source below; these are the shared location ones.
  const locationFilter = (cityCol: string, stateCol: string, countryCol: string): string => {
    const parts: string[] = [];
    if (filters.city) parts.push(`${cityCol} ILIKE ${addParam(filters.city)}`);
    if (filters.state) parts.push(`${stateCol} ILIKE ${addParam(filters.state)}`);
    if (filters.country) parts.push(`${countryCol} ILIKE ${addParam(filters.country)}`);
    return parts.length > 0 ? `AND ${parts.join(" AND ")}` : "";
  };

  const talentExtra: string[] = [];
  if (filters.experienceLevel) {
    talentExtra.push(`u."experience" = ${addParam(filters.experienceLevel)}`);
  }
  if (filters.workMode) {
    talentExtra.push(`u."workType" ILIKE ${addParam(`%${filters.workMode}%`)}`);
  }
  if (filters.roleId) {
    talentExtra.push(
      `EXISTS (SELECT 1 FROM "user_roles" ur WHERE ur."user_id" = u."id" AND ur."role_id" = ${addParam(
        filters.roleId
      )})`
    );
  }
  const talentLocation = locationFilter(`u."locationCity"`, `u."locationState"`, `u."locationCountry"`);

  const candidateExtra: string[] = [];
  const candidateLocation = locationFilter(
    `c."location_city"`,
    `c."location_state"`,
    `c."location_country"`
  );

  const limitParam = addParam(limit);
  const offsetParam = addParam(offset);

  const sql = `
    WITH talent_ranked AS (
      SELECT user_id AS id, 'registered'::text AS source, similarity
        FROM (
          SELECT te."user_id",
                 ABS($1::vector <=> te."cv_embedding"::vector) AS similarity,
                 ROW_NUMBER() OVER (
                   PARTITION BY te."user_id"
                   ORDER BY ABS($1::vector <=> te."cv_embedding"::vector) ASC
                 ) AS rn
            FROM "talent_embeddings" te
            JOIN "users" u ON u."id" = te."user_id"
           WHERE u."userRole" = 'talent'
             AND u."active" = true
             AND te."cv_embedding" IS NOT NULL
             ${talentExtra.length > 0 ? `AND ${talentExtra.join(" AND ")}` : ""}
             ${talentLocation}
        ) best
       WHERE rn = 1
    ),
    candidate_ranked AS (
      SELECT c."id" AS id, 'sourced'::text AS source,
             ABS($1::vector <=> c."embedding"::vector) AS similarity
        FROM "scout_candidates" c
       WHERE c."embedding" IS NOT NULL
         ${candidateExtra.length > 0 ? `AND ${candidateExtra.join(" AND ")}` : ""}
         ${candidateLocation}
    ),
    combined AS (
      SELECT * FROM talent_ranked
      UNION ALL
      SELECT * FROM candidate_ranked
    )
    SELECT id, source, similarity,
           COUNT(*) OVER () AS total
      FROM combined
     ORDER BY similarity ASC, id ASC
     LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const rows: Array<{ id: string; source: TalentSearchSource; similarity: string; total: string }> =
    await AppDataSource.query(sql, params);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      source: row.source,
      similarity: Number(row.similarity),
    })),
    total: rows.length > 0 ? Number(rows[0]!.total) : 0,
  };
};

export interface TalentSearchResponse {
  results: TalentSearchResult[];
  total: number;
}

/**
 * Finds the right fit from a free-text description, across registered talents and
 * candidates sourced from scouted CVs.
 *
 * Unlike the previous implementation this does not require a jobId and does not
 * filter on `prescreeningScore IS NOT NULL`, which silently hid every talent who
 * had not been pre-screened.
 */
export const searchTalents = async (
  params: TalentSearchParams
): Promise<TalentSearchResponse> => {
  const description = params.description.trim();
  if (!description) {
    throw new ValidationError("Describe who you're looking for");
  }

  let roleName = "";
  if (params.roleId) {
    const role = await roleRepo().findOne({ where: { id: params.roleId } });
    if (!role) {
      throw new NotFoundError("Role does not exist");
    }
    roleName = role.name;
  }

  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(params.offset ?? 0, 0);

  const embeddings = await createEmbedding(
    preprocessText(roleName ? `${roleName}. ${description}` : description)
  );
  const vector = embeddings[0]?.embedding;
  if (!vector) {
    throw new ValidationError("Unable to understand that description — please try rewording it");
  }

  const { rows, total } = await rankBothPools(`[${vector.toString()}]`, limit, offset, params);
  if (rows.length === 0) return { results: [], total };

  const results = await hydrate(rows);
  await attachFitEvidence(description, results);

  return { results, total };
};

const hydrate = async (rows: RankedRow[]): Promise<TalentSearchResult[]> => {
  const talentIds = rows.filter((row) => row.source === "registered").map((row) => row.id);
  const candidateIds = rows.filter((row) => row.source === "sourced").map((row) => row.id);

  const talents =
    talentIds.length > 0
      ? await userRepo()
          .createQueryBuilder("user")
          .leftJoinAndSelect("user.userRoles", "userRoles")
          .whereInIds(talentIds)
          .getMany()
      : [];
  const candidates =
    candidateIds.length > 0
      ? await candidateRepo().find({ where: candidateIds.map((id) => ({ id })) })
      : [];

  const talentsById = new Map(talents.map((talent) => [talent.id, talent]));
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  // Mapped back over `rows` so the similarity ranking survives — whereInIds and
  // find() make no ordering promise.
  return rows.flatMap<TalentSearchResult>((row) => {
    const matchScore = convertSimilarityToPercentage(Math.min(Math.max(row.similarity, 0), 1));

    if (row.source === "registered") {
      const talent = talentsById.get(row.id);
      if (!talent) return [];
      return [
        {
          id: talent.id,
          source: "registered",
          name: `${talent.firstName ?? ""} ${talent.lastName ?? ""}`.trim() || "Unnamed talent",
          headline: talent.userRoles?.[0]?.name ?? null,
          email: talent.email ?? null,
          phone: null,
          city: talent.locationCity ?? null,
          state: talent.locationState ?? null,
          country: talent.locationCountry ?? null,
          skills: talent.userRoles?.map((role) => role.name) ?? [],
          yearsExperience: null,
          experienceLevel: talent.experience ?? null,
          matchScore,
          canMessage: true,
        },
      ];
    }

    const candidate = candidatesById.get(row.id);
    if (!candidate) return [];
    return [
      {
        id: candidate.id,
        source: "sourced",
        name: candidate.fullName ?? "Unnamed candidate",
        headline: candidate.headline ?? null,
        email: candidate.emailNormalized ?? null,
        phone: candidate.phone ?? null,
        city: candidate.locationCity ?? null,
        state: candidate.locationState ?? null,
        country: candidate.locationCountry ?? null,
        skills: candidate.skills ?? [],
        yearsExperience: candidate.yearsExperience ?? null,
        experienceLevel: null,
        matchScore,
        canMessage: false,
      },
    ];
  });
};

/**
 * Adds the AI's strengths/weaknesses per result. One failure must not fail the
 * search, so each is caught individually — the result simply arrives without
 * evidence, which the UI renders as a plain match score.
 */
const attachFitEvidence = async (
  description: string,
  results: TalentSearchResult[]
): Promise<void> => {
  const texts = await loadEvidenceTexts(results);

  await Promise.all(
    results.map(async (result) => {
      const cvText = texts.get(`${result.source}:${result.id}`);
      if (!cvText) return;
      try {
        const response = await assessTalentFit({ jobDescription: description, cvText });
        const content = response?.message?.content;
        if (!content) return;
        const parsed = JSON.parse(content) as { strengths?: unknown; weaknesses?: unknown };
        if (Array.isArray(parsed.strengths)) {
          result.strengths = parsed.strengths.filter(
            (entry): entry is string => typeof entry === "string"
          );
        }
        if (Array.isArray(parsed.weaknesses)) {
          result.weaknesses = parsed.weaknesses.filter(
            (entry): entry is string => typeof entry === "string"
          );
        }
      } catch (err) {
        logger.error(
          `Talent fit evidence failed for ${result.source} ${result.id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    })
  );
};

const loadEvidenceTexts = async (
  results: TalentSearchResult[]
): Promise<Map<string, string>> => {
  const texts = new Map<string, string>();

  const talentIds = results.filter((r) => r.source === "registered").map((r) => r.id);
  if (talentIds.length > 0) {
    const rows: Array<{ user_id: string; cv_text: string }> = await AppDataSource.query(
      `SELECT "user_id", string_agg("cv_text", ' ') AS cv_text
         FROM "talent_embeddings"
        WHERE "user_id" = ANY($1)
        GROUP BY "user_id"`,
      [talentIds]
    );
    for (const row of rows) texts.set(`registered:${row.user_id}`, row.cv_text);
  }

  const candidateIds = results.filter((r) => r.source === "sourced").map((r) => r.id);
  if (candidateIds.length > 0) {
    const rows: Array<{ id: string; cv_text: string | null }> = await AppDataSource.query(
      `SELECT "id", "cv_text" FROM "scout_candidates" WHERE "id" = ANY($1)`,
      [candidateIds]
    );
    for (const row of rows) {
      if (row.cv_text) texts.set(`sourced:${row.id}`, row.cv_text);
    }
  }

  return texts;
};

export const fetchCandidate = async (candidateId: string): Promise<ScoutCandidate> => {
  const candidate = await candidateRepo().findOne({ where: { id: candidateId } });
  if (!candidate) {
    throw new NotFoundError("Candidate not found");
  }
  return candidate;
};

export { UserRole };
