import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { User } from "../src/entities/User.js";
import { Scout } from "../src/entities/Scout.js";
import { UserRole } from "../src/types/enums.js";
import { generateHashedPassword, signToken } from "../src/utils/crypto.js";
import {
  createRole,
  createScoutJob,
  createScout,
  createTalent,
  createCompleteTalent,
} from "./helpers/fixtures.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  assessCV: jest.fn().mockResolvedValue({
    message: { content: JSON.stringify({ cvScore: 80, insights: "Solid candidate" }) },
  }),
  assessCVandCoverLetter: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        cvScore: 80,
        cvInsights: "Solid candidate",
        coverLetterScore: 70,
        coverLetterInsights: "Decent letter",
      }),
    },
  }),
}));

jest.mock("../src/utils/text.js", () => ({
  ...jest.requireActual("../src/utils/text.js"),
  extractText: jest.fn().mockImplementation(async (buffer: Buffer) => buffer.toString("utf-8")),
}));

let app: ReturnType<typeof createApp>;

async function createRecruiter(
  overrides: Partial<User> = {}
): Promise<{ user: User; token: string }> {
  const user = testDataSource.getRepository(User).create({
    email: `recruiter_${Date.now()}_${Math.random()}@example.com`,
    password: await generateHashedPassword("Password1!"),
    firstName: "Bob",
    lastName: "Smith",
    userRole: UserRole.Recruiter,
    emailVerified: true,
    active: true,
    tokenVersion: 0,
    roleChangeCount: 0,
    ...overrides,
  });
  const saved = await testDataSource.getRepository(User).save(user);
  return { user: saved, token: signToken(saved) };
}

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

describe("POST /v1/scout/jobs — P0 role field regression", () => {
  it("creates a scout job and persists the correct roleId", async () => {
    const { token } = await createRecruiter();
    const role = await createRole();

    const res = await request(app)
      .post("/v1/scout/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        role: role.id,
        name: "Q1 Engineering Scout",
        jobBrief: "Looking for backend engineers",
        recruiterGuide: "Prioritize distributed systems experience",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.scoutJob.roleId).toBe(role.id);
    expect(res.body.data.scoutJob.jobBrief).toBe("Looking for backend engineers");
  });

  it("rejects a non-existent role with 404, not a silent roleId mismatch", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/scout/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        role: "00000000-0000-0000-0000-000000000000",
        name: "Bad Role Scout",
        jobBrief: "Brief",
        recruiterGuide: "Guide",
      });

    expect(res.status).toBe(404);
  });
});

describe("Scout ownership checks", () => {
  it("GET /v1/scout/jobs/:_id — 403 for a scout job owned by a different recruiter", async () => {
    const owner = await createRecruiter();
    const other = await createRecruiter();
    const scoutJob = await createScoutJob(owner.user);

    const res = await request(app)
      .get(`/v1/scout/jobs/${scoutJob.id}`)
      .set("Authorization", `Bearer ${other.token}`);

    expect(res.status).toBe(403);
  });

  it("GET /v1/scout/single/:id — 403 for a scout report owned by a different recruiter", async () => {
    const owner = await createRecruiter();
    const other = await createRecruiter();
    const scoutJob = await createScoutJob(owner.user);
    const scout = await createScout(owner.user, scoutJob);

    const res = await request(app)
      .get(`/v1/scout/single/${scout.id}`)
      .set("Authorization", `Bearer ${other.token}`);

    expect(res.status).toBe(403);
  });

  it("GET /v1/scout/batch/:id — never leaks another recruiter's rows", async () => {
    const owner = await createRecruiter();
    const other = await createRecruiter();
    const scoutJob = await createScoutJob(owner.user);
    const batchId = "9f8b6b0e-5f2a-4a4e-9b0a-1a2b3c4d5e6f";
    await createScout(owner.user, scoutJob, { batchId });

    const res = await request(app)
      .get(`/v1/scout/batch/${batchId}`)
      .set("Authorization", `Bearer ${other.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.scoutReports).toEqual([]);
  });

});

describe("GET /v1/scout/talents — standalone Talent Search (not job-scoped)", () => {
  it("returns matched talents without requiring any scout job context", async () => {
    const { token } = await createRecruiter();
    const { user: talent } = await createCompleteTalent(await createRole());
    await testDataSource.getRepository(User).update(talent.id, { prescreeningScore: 80 });

    const res = await request(app)
      .get("/v1/scout/talents")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.talents)).toBe(true);
    expect(res.body.data.talents.some((t: { id: string }) => t.id === talent.id)).toBe(true);
  });

  it("filters by role", async () => {
    const { token } = await createRecruiter();
    const role = await createRole();
    const otherRole = await createRole();
    const { user: matchingTalent } = await createCompleteTalent(role);
    await testDataSource
      .getRepository(User)
      .update(matchingTalent.id, { prescreeningScore: 80 });
    const { user: otherTalent } = await createCompleteTalent(otherRole);
    await testDataSource.getRepository(User).update(otherTalent.id, { prescreeningScore: 80 });

    const res = await request(app)
      .get(`/v1/scout/talents?roleId=${role.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.talents.map((t: { id: string }) => t.id);
    expect(ids).toContain(matchingTalent.id);
    expect(ids).not.toContain(otherTalent.id);
  });

  it("Talent cannot access → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .get("/v1/scout/talents")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).get("/v1/scout/talents");
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/scout/cv-batch — atomic batch scoring", () => {
  it("persists all rows together, tagged with one batchId, when every file scores successfully", async () => {
    const { token, user } = await createRecruiter();
    const scoutJob = await createScoutJob(user);

    const res = await request(app)
      .post("/v1/scout/cv-batch")
      .set("Authorization", `Bearer ${token}`)
      .field("scoutJobId", scoutJob.id)
      .attach("cv", Buffer.from("Experienced engineer resume"), "resume1.pdf")
      .attach("cv", Buffer.from("Another strong candidate resume"), "resume2.pdf");

    expect(res.status).toBe(200);
    expect(res.body.data.scoutReports).toHaveLength(2);
    const batchIds = new Set(res.body.data.scoutReports.map((s: Scout) => s.batchId));
    expect(batchIds.size).toBe(1);

    const persisted = await testDataSource
      .getRepository(Scout)
      .find({ where: { scoutJobId: scoutJob.id } });
    expect(persisted).toHaveLength(2);
  });

  it("persists nothing when one file in the batch cannot be scored", async () => {
    const { token, user } = await createRecruiter();
    const scoutJob = await createScoutJob(user);

    const textExtractor = jest.requireMock("../src/utils/text.js") as {
      extractText: jest.Mock;
    };
    textExtractor.extractText
      .mockResolvedValueOnce("A perfectly good resume")
      .mockResolvedValueOnce(""); // second file fails extraction

    const res = await request(app)
      .post("/v1/scout/cv-batch")
      .set("Authorization", `Bearer ${token}`)
      .field("scoutJobId", scoutJob.id)
      .attach("cv", Buffer.from("good resume"), "good.pdf")
      .attach("cv", Buffer.from(""), "corrupt.pdf");

    expect(res.status).toBe(400);
    expect(res.body.error.fields).toHaveProperty(["corrupt.pdf"]);

    const persisted = await testDataSource
      .getRepository(Scout)
      .find({ where: { scoutJobId: scoutJob.id } });
    expect(persisted).toHaveLength(0);
  });

  it("scores CV-only when no cover letter is attached (cover letter is optional)", async () => {
    const { token, user } = await createRecruiter();
    const scoutJob = await createScoutJob(user);

    const res = await request(app)
      .post("/v1/scout/cv-batch")
      .set("Authorization", `Bearer ${token}`)
      .field("scoutJobId", scoutJob.id)
      .attach("cv", Buffer.from("Solo resume, no cover letter"), "resume.pdf");

    expect(res.status).toBe(200);
    expect(res.body.data.scoutReports[0].coverLetterScore).toBeNull();
    expect(res.body.data.scoutReports[0].evaluationScore).toBe(80);
  });

  it("rejects a batch where cover letters don't match the CV count", async () => {
    const { token, user } = await createRecruiter();
    const scoutJob = await createScoutJob(user);

    const res = await request(app)
      .post("/v1/scout/cv-batch")
      .set("Authorization", `Bearer ${token}`)
      .field("scoutJobId", scoutJob.id)
      .attach("cv", Buffer.from("resume one"), "resume1.pdf")
      .attach("cv", Buffer.from("resume two"), "resume2.pdf")
      .attach("coverLetter", Buffer.from("only one cover letter"), "cl1.pdf");

    expect(res.status).toBe(400);
  });

  it("rejects a batch for a scoutJobId owned by a different recruiter", async () => {
    const owner = await createRecruiter();
    const other = await createRecruiter();
    const scoutJob = await createScoutJob(owner.user);

    const res = await request(app)
      .post("/v1/scout/cv-batch")
      .set("Authorization", `Bearer ${other.token}`)
      .field("scoutJobId", scoutJob.id)
      .attach("cv", Buffer.from("resume"), "resume.pdf");

    expect(res.status).toBe(403);
  });
});
