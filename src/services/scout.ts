import crypto from "crypto";
import { FindOptionsWhere } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Scout, ScoutJob, User, Role, Job } from "../entities";
import { NotFoundError, AuthorizationError, ValidationError } from "../utils/errors";
import { UserRole } from "../types/enums.js";
import { extractText, preprocessText } from "../utils/text.js";
import * as AI from "../utils/integrations/openai.js";
import { v4 as uuidv4 } from "uuid";
import {
  rankTalentIdsByJobEmbedding,
  enrichTalentsWithFitEvidence,
  TalentWithFitEvidence,
} from "./job.js";

const scoutRepo = () => AppDataSource.getRepository(Scout);

const scoutJobRepo = () => AppDataSource.getRepository(ScoutJob);

const MAX_PAGE_SIZE = 100;

const userRepo = () => AppDataSource.getRepository(User);

const roleRepo = () => AppDataSource.getRepository(Role);

const jobRepo = () => AppDataSource.getRepository(Job);

export interface SearchTalentsParams {
  roleId?: string;
  experience?: string;
  country?: string;
  state?: string;
  city?: string;
  workMode?: string;
  limit?: number | string;
  offset?: number | string;
  /** When present, ranks results by CV-embedding fit to this job instead of plain filtering. */
  jobId?: string;
  percentage?: number;
}

export interface FetchScoutReportsParams {
  batchId?: string;
  scoutJobId?: string;
  userId: string;
  isAdmin: boolean;
  limit?: number | string;
  offset?: number | string;
}

export const fetchScoutReports = async (payload: FetchScoutReportsParams): Promise<Scout[]> => {
  const where: FindOptionsWhere<Scout> = {};
  if (payload.batchId) where.batchId = payload.batchId;
  if (payload.scoutJobId) where.scoutJobId = payload.scoutJobId;
  if (!payload.isAdmin) where.recruiterId = payload.userId;

  const limit = Math.min(Number(payload.limit) || 50, MAX_PAGE_SIZE);
  const offset = Number(payload.offset) || 0;

  return scoutRepo().find({
    where,
    relations: { scoutJob: true, recruiter: true },
    order: { createdAt: "DESC" },
    take: limit,
    skip: offset,
  });
};

export const fetchScoutReport = async (
  id: string,
  userId: string,
  isAdmin: boolean
): Promise<Scout | null> => {
  const scout = await scoutRepo().findOne({
    where: { id },
    relations: { scoutJob: true, recruiter: true },
  });
  if (!scout) return null;
  if (!isAdmin && scout.recruiterId !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }
  return scout;
};

// A plain filtered directory search across the whole talent database — not
// scoped to any job/scout-job, so there's no job description to compute a
// CV-similarity percentage against (unlike the job-scoped topTalents/scoutCvBatch
// flows, which do have one) — unless the caller passes a jobId, in which case
// results are ranked by embedding fit to that job instead. Read-only either way:
// unlike topTalents, this never creates/mutates Application rows.
export const searchTalents = async (
  userId: string,
  userRole: UserRole,
  payload: SearchTalentsParams
): Promise<TalentWithFitEvidence[]> => {
  if (payload.jobId) {
    return searchTalentsByJobFit(userId, userRole, payload.jobId, payload);
  }

  const qb = userRepo()
    .createQueryBuilder("user")
    .leftJoinAndSelect("user.userRoles", "userRoles")
    .where("user.userRole = :role", { role: UserRole.Talent })
    .andWhere("user.prescreeningScore IS NOT NULL");

  if (payload.roleId) {
    const role = await roleRepo().findOne({ where: { id: payload.roleId } });
    if (!role) {
      throw new NotFoundError("Role does not exist");
    }
    qb.andWhere("userRoles.id = :roleId", { roleId: payload.roleId });
  }

  if (payload.experience) {
    qb.andWhere("user.experience = :experience", { experience: payload.experience });
  }

  if (payload.country) {
    qb.andWhere("user.locationCountry = :country", { country: payload.country });
  }

  if (payload.state) {
    qb.andWhere("user.locationState = :state", { state: payload.state });
  }

  if (payload.city) {
    qb.andWhere("user.locationCity = :city", { city: payload.city });
  }

  if (payload.workMode) {
    qb.andWhere("user.workType LIKE :workMode", { workMode: `%${payload.workMode}%` });
  }

  const limit = Math.min(Number(payload.limit) || 50, MAX_PAGE_SIZE);
  const offset = Number(payload.offset) || 0;

  return qb.orderBy("user.prescreeningScore", "DESC").skip(offset).take(limit).getMany();
};

const searchTalentsByJobFit = async (
  userId: string,
  userRole: UserRole,
  jobId: string,
  payload: SearchTalentsParams
): Promise<TalentWithFitEvidence[]> => {
  const job = await jobRepo().findOne({ where: { id: jobId }, relations: { aiConfig: true } });
  if (!job) {
    throw new NotFoundError("Job does not exist");
  }
  if (job.postedById !== userId && userRole !== UserRole.Admin) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  const limit = Math.min(Number(payload.limit) || 50, MAX_PAGE_SIZE);
  const percentage = payload.percentage ?? job.aiConfig?.minCvSimilarityScore ?? 50;
  const strictness = (100 - percentage) / 100;

  const ranked = await rankTalentIdsByJobEmbedding(jobId, strictness, limit);
  const talentIds = ranked.map((r) => r.user_id);
  if (talentIds.length === 0) return [];

  const talentsById = new Map(
    (
      await userRepo()
        .createQueryBuilder("user")
        .whereInIds(talentIds)
        .leftJoinAndSelect("user.userRoles", "userRoles")
        .getMany()
    ).map((t) => [t.id, t as TalentWithFitEvidence])
  );
  // Preserve the similarity ranking — whereInIds doesn't guarantee row order.
  const talents = ranked
    .map((r) => talentsById.get(r.user_id))
    .filter((t): t is TalentWithFitEvidence => t !== undefined);

  await enrichTalentsWithFitEvidence(job.jobBrief, talents);

  return talents;
};

// ---------------------------------------------------------------------------
// CV batch scoring — a single request scores every CV (with an optional,
// batch-wide-paired cover letter) and persists them together, or persists
// nothing. See services/scout.ts callers in controllers/scout.ts and the
// production-readiness plan for the rationale.
// ---------------------------------------------------------------------------

interface AssessmentResult {
  cvScore?: number;
  insights?: string;
  cvInsights?: string;
  coverLetterScore?: number;
  coverLetterInsights?: string;
}

const MAX_ASSESSMENT_ATTEMPTS = 3;

const hashText = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

// Retries the LLM call + JSON parse up to MAX_ASSESSMENT_ATTEMPTS times. Genuine
// network/rate-limit failures are already retried inside utils/integrations/openai.ts;
// this loop covers the separate failure mode of a successful-but-malformed or
// incomplete response, which is usually a one-off glitch worth retrying rather than
// failing the whole batch over.
const assessWithRetry = async (
  job: ScoutJob,
  cvText: string,
  coverLetterText: string | null,
  fileLabel: string
): Promise<AssessmentResult> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ASSESSMENT_ATTEMPTS; attempt++) {
    try {
      const response = coverLetterText
        ? await AI.assessCVandCoverLetter(
            JSON.stringify({
              cv: cvText,
              coverLetter: coverLetterText,
              jobDescription: job.jobBrief,
              recruiterGuide: job.recruiterGuide,
            })
          )
        : await AI.assessCV(
            JSON.stringify({
              cv: cvText,
              jobDescription: job.jobBrief,
              recruiterGuide: job.recruiterGuide,
            })
          );

      if (!response?.message?.content) {
        throw new Error("Empty response from AI service");
      }
      const parsed = JSON.parse(response.message.content) as AssessmentResult;
      if (!parsed.cvScore || (coverLetterText && !parsed.coverLetterScore)) {
        throw new Error("AI service did not return a complete score");
      }
      return parsed;
    } catch (err) {
      lastError = err;
    }
  }
  throw new ValidationError(
    `Unable to score ${fileLabel}: AI service did not return a valid assessment after ${MAX_ASSESSMENT_ATTEMPTS} attempts${
      lastError instanceof Error ? ` (${lastError.message})` : ""
    }`
  );
};

interface ScoredCv {
  cvName: string;
  cvText: string;
  cvTextHash: string;
  cvScore: number;
  insights: string | null;
  coverLetterName: string | null;
  coverLetterText: string | null;
  coverLetterScore: number | null;
  coverLetterInsights: string | null;
  evaluationScore: number;
}

const scoreOneCv = async (
  job: ScoutJob,
  scoutJobId: string,
  recruiterId: string,
  cvFile: Express.Multer.File,
  coverLetterFile: Express.Multer.File | undefined
): Promise<ScoredCv> => {
  const cvName = cvFile.originalname.split(".")[0] ?? cvFile.originalname;
  const extractedCv = await extractText(cvFile.buffer, cvFile.mimetype);
  if (!extractedCv) {
    throw new ValidationError(`Unable to extract text from ${cvFile.originalname}`);
  }
  const cvText = preprocessText(extractedCv);
  const cvTextHash = hashText(cvText);

  let coverLetterName: string | null = null;
  let coverLetterText: string | null = null;
  if (coverLetterFile) {
    coverLetterName = coverLetterFile.originalname.split(".")[0] ?? coverLetterFile.originalname;
    const extractedCl = await extractText(coverLetterFile.buffer, coverLetterFile.mimetype);
    if (!extractedCl) {
      throw new ValidationError(`Unable to extract text from ${coverLetterFile.originalname}`);
    }
    coverLetterText = preprocessText(extractedCl);
  }

  // Dedup: an exact repeat of this CV (same text, same cover-letter presence/content)
  // against the same job for the same recruiter reuses the prior score instead of
  // spending another LLM call.
  const existing = await scoutRepo().findOne({
    where: { scoutJobId, recruiterId, cvTextHash },
    order: { createdAt: "DESC" },
  });
  const isExactRepeat =
    !!existing &&
    (coverLetterFile
      ? existing.coverLetterText === coverLetterText
      : existing.coverLetterText === null);

  if (existing && isExactRepeat) {
    return {
      cvName,
      cvText,
      cvTextHash,
      cvScore: existing.cvScore!,
      insights: existing.insights,
      coverLetterName,
      coverLetterText,
      coverLetterScore: existing.coverLetterScore,
      coverLetterInsights: existing.coverLetterInsights,
      evaluationScore: existing.evaluationScore!,
    };
  }

  const assessment = await assessWithRetry(job, cvText, coverLetterText, cvFile.originalname);
  const cvScore = assessment.cvScore!;
  const coverLetterScore = coverLetterFile ? assessment.coverLetterScore! : null;
  const evaluationScore = coverLetterFile
    ? Number(((cvScore + coverLetterScore!) / 2).toFixed(2))
    : cvScore;

  return {
    cvName,
    cvText,
    cvTextHash,
    cvScore,
    insights: (coverLetterFile ? assessment.cvInsights : assessment.insights) ?? null,
    coverLetterName,
    coverLetterText,
    coverLetterScore,
    coverLetterInsights: coverLetterFile ? (assessment.coverLetterInsights ?? null) : null,
    evaluationScore,
  };
};

export interface ScoutCvBatchPayload {
  scoutJobId: string;
  cvFiles: Express.Multer.File[];
  coverLetterFiles?: Express.Multer.File[];
}

export const scoutCvBatch = async (
  userId: string,
  payload: ScoutCvBatchPayload
): Promise<{ batchId: string; scoutReports: Scout[]; failures?: Record<string, string> }> => {
  const job = await scoutJobRepo().findOne({ where: { id: payload.scoutJobId } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (job.postedById !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  const { cvFiles, coverLetterFiles } = payload;
  const batchId = uuidv4();

  // Every file gets its full, independent chance to be scored (including its own
  // retry budget) before we decide whether the batch as a whole can be persisted —
  // one file's failure shouldn't cut short another file's in-flight attempt.
  const settled = await Promise.allSettled(
    cvFiles.map((cvFile, i) =>
      scoreOneCv(job, payload.scoutJobId, userId, cvFile, coverLetterFiles?.[i])
    )
  );

  const scored: ScoredCv[] = [];
  const failures: Record<string, string> = {};
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      scored.push(result.value);
    } else {
      const reason =
        result.reason instanceof Error ? result.reason.message : "Unable to score this CV";
      failures[cvFiles[i]!.originalname] = reason;
    }
  });

  // Every file that *did* score successfully is persisted regardless of whether
  // others in the same batch failed — losing a good score because an unrelated
  // file in the same upload failed would make per-file retry pointless (there'd
  // be nothing left to keep). Failures are reported alongside so the caller can
  // retry just those files.
  const rows = scored.map((s) =>
    scoutRepo().create({ ...s, batchId, scoutJobId: payload.scoutJobId, recruiterId: userId })
  );

  const saved =
    rows.length > 0
      ? await AppDataSource.transaction((manager) => manager.getRepository(Scout).save(rows))
      : [];

  return {
    batchId,
    scoutReports: saved,
    ...(Object.keys(failures).length > 0 ? { failures } : {}),
  };
};
