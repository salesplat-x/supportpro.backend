import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { TalentEmbedding } from "../src/entities/TalentEmbedding.js";
import { ScoutCandidate } from "../src/entities/ScoutCandidate.js";
import { Organization } from "../src/entities/Organization.js";
import { User } from "../src/entities/User.js";
import { CvEmbeddingStatus, ExperienceLevel, WorkMode } from "../src/types/enums.js";
import {
  createOrganization,
  createRole,
  createTalent,
  createScoutCandidate,
} from "./helpers/fixtures.js";
import { createRecruiter } from "./helpers/scout.js";
import { apiData } from "./helpers/http.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn(),
  assessTalentFit: jest.fn(),
  scoutAssessCandidate: jest.fn(),
  scoutShortlistSummary: jest.fn(),
}));

const ai = jest.requireMock("../src/utils/integrations/openai.js") as {
  createEmbedding: jest.Mock;
  assessTalentFit: jest.Mock;
};

let app: ReturnType<typeof createApp>;

/** A 512-dim vector pointing mostly along one axis, so distances are predictable. */
const vector = (lead: number): number[] => {
  const values = new Array<number>(512).fill(0.01);
  values[0] = lead;
  return values;
};

const asLiteral = (values: number[]) => `[${values.toString()}]`;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  ai.createEmbedding.mockResolvedValue([{ embedding: vector(1) }]);
  ai.assessTalentFit.mockResolvedValue({
    message: {
      content: JSON.stringify({
        strengths: ["Five years selling into banks, per the CV."],
        weaknesses: ["No public-sector experience mentioned."],
      }),
    },
  });
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

const searcher = async () => {
  const { user, token } = await createRecruiter();
  const org = await createOrganization(user);
  return { user, token, org };
};

const search = (token: string, body: Record<string, unknown>) =>
  request(app)
    .post("/v1/scout/talents/search")
    .set("Authorization", `Bearer ${token}`)
    .send(body);

const DESCRIPTION =
  "An enterprise account executive who has sold payments software to Nigerian banks.";

/** A registered talent with one embedded CV chunk. */
const embeddedTalent = async (lead: number, overrides: Partial<User> = {}) => {
  const talent = await createTalent(overrides);
  await testDataSource.getRepository(TalentEmbedding).save(
    testDataSource.getRepository(TalentEmbedding).create({
      userId: talent.user.id,
      cvText: "Enterprise AE with bank experience.",
      cvEmbedding: asLiteral(vector(lead)),
      generatedAt: new Date(),
    })
  );
  return talent;
};

const embeddedCandidate = async (lead: number, overrides: Partial<ScoutCandidate> = {}) =>
  createScoutCandidate({
    embedding: asLiteral(vector(lead)),
    embeddingStatus: CvEmbeddingStatus.Ready,
    ...overrides,
  });

describe("POST /v1/scout/talents/search", () => {
  it("finds both registered talents and sourced candidates from a description", async () => {
    const { token } = await searcher();
    await embeddedTalent(1);
    await embeddedCandidate(1, { fullName: "Sourced Sam" });

    const res = await search(token, { description: DESCRIPTION });

    expect(res.status).toBe(200);
    const body = apiData<{
      results: Array<{ source: string; name: string; matchScore: number; canMessage: boolean }>;
      total: number;
    }>(res);
    expect(body.total).toBe(2);
    expect(body.results.map((r) => r.source).sort()).toEqual(["registered", "sourced"]);
    expect(body.results.every((r) => r.matchScore > 0)).toBe(true);
  });

  it("marks only registered talents as messageable", async () => {
    const { token } = await searcher();
    await embeddedTalent(1);
    await embeddedCandidate(1);

    const res = await search(token, { description: DESCRIPTION });
    const body = apiData<{ results: Array<{ source: string; canMessage: boolean }> }>(res);

    expect(body.results.find((r) => r.source === "registered")!.canMessage).toBe(true);
    expect(body.results.find((r) => r.source === "sourced")!.canMessage).toBe(false);
  });

  it("ranks a closer match above a weaker one", async () => {
    const { token } = await searcher();
    await embeddedCandidate(1, { fullName: "Close Match" });
    await embeddedCandidate(-1, { fullName: "Poor Match" });

    const res = await search(token, { description: DESCRIPTION });
    const names = apiData<{ results: Array<{ name: string }> }>(res).results.map((r) => r.name);

    expect(names[0]).toBe("Close Match");
  });

  it("represents a talent by their best CV chunk, not their worst", async () => {
    const { token } = await searcher();
    const strong = await createTalent({ firstName: "Strong", lastName: "Fit" });
    const repo = testDataSource.getRepository(TalentEmbedding);
    // One excellent chunk and one poor one. Ranking on the worst chunk would push
    // this talent below the middling candidate below.
    await repo.save(
      repo.create({
        userId: strong.user.id,
        cvText: "Exactly the right experience.",
        cvEmbedding: asLiteral(vector(1)),
        generatedAt: new Date(),
      })
    );
    await repo.save(
      repo.create({
        userId: strong.user.id,
        cvText: "An unrelated hobby section.",
        cvEmbedding: asLiteral(vector(-1)),
        generatedAt: new Date(),
      })
    );
    await embeddedCandidate(0.2, { fullName: "Middling" });

    const res = await search(token, { description: DESCRIPTION });
    const names = apiData<{ results: Array<{ name: string }> }>(res).results.map((r) => r.name);

    expect(names[0]).toBe("Strong Fit");
  });

  it("lists a talent once even with several embedded chunks", async () => {
    const { token } = await searcher();
    const talent = await createTalent();
    const repo = testDataSource.getRepository(TalentEmbedding);
    for (const lead of [1, 0.5, 0.2]) {
      await repo.save(
        repo.create({
          userId: talent.user.id,
          cvText: "chunk",
          cvEmbedding: asLiteral(vector(lead)),
          generatedAt: new Date(),
        })
      );
    }

    const res = await search(token, { description: DESCRIPTION });
    expect(apiData<{ total: number }>(res).total).toBe(1);
  });

  it("includes talents who have never been pre-screened", async () => {
    const { token } = await searcher();
    await embeddedTalent(1, { prescreeningScore: null });

    const res = await search(token, { description: DESCRIPTION });
    expect(apiData<{ total: number }>(res).total).toBe(1);
  });

  it("attaches the AI's strengths and weaknesses to each result", async () => {
    const { token } = await searcher();
    await embeddedTalent(1);

    const res = await search(token, { description: DESCRIPTION });
    const [result] = apiData<{
      results: Array<{ strengths?: string[]; weaknesses?: string[] }>;
    }>(res).results;

    expect(result!.strengths).toEqual(["Five years selling into banks, per the CV."]);
    expect(result!.weaknesses).toEqual(["No public-sector experience mentioned."]);
  });

  it("still returns results when the evidence pass fails for one candidate", async () => {
    const { token } = await searcher();
    await embeddedTalent(1);
    ai.assessTalentFit.mockRejectedValue(new Error("model down"));

    const res = await search(token, { description: DESCRIPTION });

    expect(res.status).toBe(200);
    const [result] = apiData<{ results: Array<{ strengths?: string[] }> }>(res).results;
    expect(result!.strengths).toBeUndefined();
  });

  it("ignores candidates that have not been embedded yet", async () => {
    const { token } = await searcher();
    await createScoutCandidate({ embedding: null });

    const res = await search(token, { description: DESCRIPTION });
    expect(apiData<{ total: number }>(res).total).toBe(0);
  });

  it("returns an empty result set rather than an error when nothing matches", async () => {
    const { token } = await searcher();

    const res = await search(token, { description: DESCRIPTION });

    expect(res.status).toBe(200);
    const body = apiData<{ results: unknown[]; total: number }>(res);
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("surfaces sourced candidates across organization boundaries", async () => {
    const { user: otherRecruiter } = await createRecruiter();
    const otherOrg = await createOrganization(otherRecruiter);
    await embeddedCandidate(1, {
      fullName: "Someone Else's Find",
      firstSourcedByOrganizationId: otherOrg.id,
    });

    const { token } = await searcher();
    const res = await search(token, { description: DESCRIPTION });

    const names = apiData<{ results: Array<{ name: string }> }>(res).results.map((r) => r.name);
    expect(names).toContain("Someone Else's Find");
  });
});

describe("talent search filters", () => {
  it("filters registered talents by role", async () => {
    const { token } = await searcher();
    const role = await createRole();
    const matching = await embeddedTalent(1);
    await embeddedTalent(1);

    await testDataSource.query(
      `INSERT INTO "user_roles" ("user_id", "role_id") VALUES ($1, $2)`,
      [matching.user.id, role.id]
    );

    const res = await search(token, { description: DESCRIPTION, roleId: role.id });
    expect(apiData<{ total: number }>(res).total).toBe(1);
  });

  it("filters by experience level", async () => {
    const { token } = await searcher();
    await embeddedTalent(1, { experience: ExperienceLevel.FourToSix });
    await embeddedTalent(1, { experience: ExperienceLevel.SixteenPlus });

    const res = await search(token, {
      description: DESCRIPTION,
      experienceLevel: ExperienceLevel.FourToSix,
    });
    expect(apiData<{ total: number }>(res).total).toBe(1);
  });

  it("filters by work mode", async () => {
    const { token } = await searcher();
    await embeddedTalent(1, { workType: [WorkMode.Remote] });
    await embeddedTalent(1, { workType: [WorkMode.OnSite] });

    const res = await search(token, { description: DESCRIPTION, workMode: WorkMode.Remote });
    expect(apiData<{ total: number }>(res).total).toBe(1);
  });

  it("matches location case-insensitively across both pools", async () => {
    const { token } = await searcher();
    await embeddedTalent(1, { locationCity: "Lagos" });
    await embeddedCandidate(1, { locationCity: "lagos" });
    await embeddedCandidate(1, { locationCity: "Abuja" });

    const res = await search(token, { description: DESCRIPTION, city: "LAGOS" });
    expect(apiData<{ total: number }>(res).total).toBe(2);
  });

  it("404s an unknown role", async () => {
    const { token } = await searcher();
    const res = await search(token, {
      description: DESCRIPTION,
      roleId: "11111111-1111-4111-8111-111111111111",
    });
    expect(res.status).toBe(404);
  });
});

describe("talent search validation", () => {
  it("rejects a description that is too short to search on", async () => {
    const { token } = await searcher();
    const res = await search(token, { description: "sales guy" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing description", async () => {
    const { token } = await searcher();
    const res = await search(token, {});
    expect(res.status).toBe(400);
  });

  it("rejects a description over the length cap", async () => {
    const { token } = await searcher();
    const res = await search(token, { description: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });

  it("rejects a limit above the maximum", async () => {
    const { token } = await searcher();
    const res = await search(token, { description: DESCRIPTION, limit: 500 });
    expect(res.status).toBe(400);
  });

  it("caps the page size at 50 results", async () => {
    const { token } = await searcher();
    for (let i = 0; i < 3; i++) await embeddedCandidate(1 - i * 0.1);

    const res = await search(token, { description: DESCRIPTION, limit: 2 });
    expect(apiData<{ results: unknown[]; total: number }>(res).results).toHaveLength(2);
    expect(apiData<{ total: number }>(res).total).toBe(3);
  });

  it("pages through results with an offset", async () => {
    const { token } = await searcher();
    await embeddedCandidate(1, { fullName: "First" });
    await embeddedCandidate(0.5, { fullName: "Second" });

    const page2 = await search(token, { description: DESCRIPTION, limit: 1, offset: 1 });
    const names = apiData<{ results: Array<{ name: string }> }>(page2).results.map((r) => r.name);
    expect(names).toEqual(["Second"]);
  });

  it("fails cleanly when the embedding provider returns nothing", async () => {
    const { token } = await searcher();
    ai.createEmbedding.mockResolvedValue([]);

    const res = await search(token, { description: DESCRIPTION });
    expect(res.status).toBe(400);
  });
});

describe("talent search access control", () => {
  it("401s without a token", async () => {
    const res = await request(app)
      .post("/v1/scout/talents/search")
      .send({ description: DESCRIPTION });
    expect(res.status).toBe(401);
  });

  it("403s a talent", async () => {
    const talent = await createTalent();
    const res = await search(talent.token, { description: DESCRIPTION });
    expect(res.status).toBe(403);
  });

  it("requires an active company", async () => {
    const { token } = await createRecruiter();
    const res = await search(token, { description: DESCRIPTION });
    expect(res.status).toBe(400);
  });
});

describe("talent search plan limits", () => {
  it("402s once the monthly search allowance is used up", async () => {
    const { token, org } = await searcher();
    await testDataSource
      .getRepository(Organization)
      .update(org.id, { billingPlan: "sme_basic" });
    // sme_basic allows 10 talent searches a month.
    await testDataSource.query(
      `INSERT INTO "feature_usage_counters"
         ("organization_id", "feature_key", "period_start", "count", "createdAt", "updatedAt")
       VALUES ($1, 'talent_searches', date_trunc('month', now())::date, 10, now(), now())`,
      [org.id]
    );

    const res = await search(token, { description: DESCRIPTION });

    expect(res.status).toBe(402);
    expect(res.body.error.featureKey).toBe("talent_searches");
  });

  it("records one unit of usage per search", async () => {
    const { token, org } = await searcher();
    await testDataSource
      .getRepository(Organization)
      .update(org.id, { billingPlan: "sme_basic" });

    await search(token, { description: DESCRIPTION });
    await search(token, { description: DESCRIPTION });

    const rows: Array<{ count: number }> = await testDataSource.query(
      `SELECT "count" FROM "feature_usage_counters"
        WHERE "organization_id" = $1 AND "feature_key" = 'talent_searches'`,
      [org.id]
    );
    expect(rows[0]!.count).toBe(2);
  });
});
