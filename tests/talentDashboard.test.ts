import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createRecruiter,
  createOrganization,
  createRole,
  createJob,
  createAIConfig,
  createApplication,
  createTalent,
} from "./helpers/fixtures.js";
import {
  ApplicationStatus,
  ApplicationType,
  JobStatus,
  ScreeningStage,
} from "../src/types/enums.js";
import { createStages } from "../src/services/aiConfig.js";
import { apiData } from "./helpers/http.js";
import { AiInterview } from "../src/entities/AiInterview.js";
import type { User } from "../src/entities/User.js";
import type { Job } from "../src/entities/Job.js";
import type { AIConfig } from "../src/entities/AIConfig.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

let app: ReturnType<typeof createApp>;

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

const vector = (values: number[]) => `[${values.join(",")}]`;

const addCvChunk = (talent: User, values: number[]) =>
  testDataSource.query(
    `INSERT INTO talent_embeddings (user_id, cv_text, cv_embedding, generated_at)
     VALUES ($1, 'cv', $2, now())`,
    [talent.id, vector(values)]
  );

let recruiter: User;
let config: AIConfig;
let organizationId: string;

const matchJob = async (
  name: string,
  values: number[] | null,
  overrides: Partial<Job> = {}
): Promise<Job> => {
  const job = await createJob(recruiter, await createRole(name), {
    organizationId,
    aiConfigId: config.id,
    ...overrides,
  });
  if (values) {
    await testDataSource.query(`UPDATE jobs SET job_embedding = $2 WHERE id = $1`, [
      job.id,
      vector(values),
    ]);
  }
  return job;
};

const setJobAge = (job: Job, hours: number) =>
  testDataSource.query(
    `UPDATE jobs SET "createdAt" = LOCALTIMESTAMP - make_interval(hours => $2) WHERE id = $1`,
    [job.id, hours]
  );

const fetchDashboard = (token: string) =>
  request(app).get("/v1/user/dashboard").set("Authorization", `Bearer ${token}`);

beforeEach(async () => {
  recruiter = (await createRecruiter()).user;
  const org = await createOrganization(recruiter, { name: "Brightline" });
  organizationId = org.id;
  config = await createAIConfig(recruiter, { minCvSimilarityScore: 50 });
});

describe("GET /v1/user/dashboard", () => {
  it("says the CV isn't ready when the talent has no CV embedding yet", async () => {
    const { token } = await createTalent();
    await matchJob("Product Designer", [1, 0, 0]);

    const res = await fetchDashboard(token);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ cvReady: false, matches: [], newMatchesToday: 0 });
  });

  it("ranks jobs by the best CV chunk and survives opposite, zero and mismatched vectors", async () => {
    const { user: talent, token } = await createTalent();
    await addCvChunk(talent, [1, 0, 0]);
    await addCvChunk(talent, [0, 0, 1]);
    const exact = await matchJob("Exact", [1, 0, 0]);
    const close = await matchJob("Close", [1, 1, 0]);
    const opposite = await matchJob("Opposite", [-1, 0, -1]);
    await matchJob("Zero", [0, 0, 0]);
    await matchJob("Wrong size", [1, 0]);

    const res = await fetchDashboard(token);

    expect(res.status).toBe(200);
    const matches = res.body.data.matches as Array<{ jobId: string; matchPercent: number }>;
    expect(matches.map((match) => match.jobId)).toEqual([exact.id, close.id, opposite.id]);
    expect(matches[0]!.matchPercent).toBe(100);
    expect(matches[1]!.matchPercent).toBeCloseTo(70.71, 1);
    expect(matches[2]!.matchPercent).toBe(0);
    expect(res.body.data.cvReady).toBe(true);
  });

  it("leaves out jobs the talent can't apply to or already has an application for", async () => {
    const { user: talent, token } = await createTalent();
    await addCvChunk(talent, [1, 0, 0]);
    const open = await matchJob("Open", [1, 0, 0]);
    await matchJob("No AI config", [1, 0, 0], { aiConfigId: null });
    await matchJob("Closed", [1, 0, 0], { status: JobStatus.Closed });
    await matchJob("No embedding", null);
    const applied = await matchJob("Applied", [1, 0, 0]);
    const invited = await matchJob("Invited", [1, 0, 0]);
    await createApplication(talent, applied);
    await createApplication(talent, invited, { applicationType: ApplicationType.Invitation });

    const res = await fetchDashboard(token);

    expect(res.body.data.matches.map((match: { jobId: string }) => match.jobId)).toEqual([open.id]);
  });

  it("returns at most four matches with public job fields only", async () => {
    const { user: talent, token } = await createTalent();
    await addCvChunk(talent, [1, 0, 0]);
    for (let i = 0; i < 5; i++) {
      await matchJob(`Role ${i}`, [1, i * 0.1, 0], { workMode: ["remote", "hybrid"] });
    }

    const res = await fetchDashboard(token);

    const matches = res.body.data.matches as Array<Record<string, unknown>>;
    expect(matches).toHaveLength(4);
    expect(matches[0]).toMatchObject({
      title: "Role 0",
      company: "Brightline",
      workMode: ["remote", "hybrid"],
      state: "Lagos",
      country: "Nigeria",
    });
    expect(Object.keys(matches[0]!).sort()).toEqual(
      [
        "city",
        "company",
        "companyLogoUrl",
        "country",
        "createdAt",
        "jobId",
        "matchPercent",
        "state",
        "title",
        "workMode",
      ].sort()
    );
  });

  it("counts new matches from the last 24 hours that reach each job's own threshold", async () => {
    const { user: talent, token } = await createTalent();
    await addCvChunk(talent, [1, 0, 0]);
    await matchJob("New and strong", [1, 0, 0]);
    const strict = await createAIConfig(recruiter, { minCvSimilarityScore: 90 });
    await matchJob("New but below its bar", [1, 1, 0], { aiConfigId: strict.id });
    const unset = await createAIConfig(recruiter, { minCvSimilarityScore: null });
    await matchJob("New with default bar", [1, 1, 0], { aiConfigId: unset.id });
    const old = await matchJob("Old", [1, 0, 0]);
    await setJobAge(old, 25);

    const res = await fetchDashboard(token);

    expect(res.body.data.matches).toHaveLength(4);
    expect(res.body.data.newMatchesToday).toBe(2);
  });

  it("is talent-only", async () => {
    const { token } = await createRecruiter();

    expect((await fetchDashboard(token)).status).toBe(403);
  });
});

describe("GET /v1/user/dashboard — applications summary", () => {
  const SWITCHES = {
    prescreeningAssessment: true,
    cvSimilarity: false,
    personalizedAssessment: false,
    problemSolvingAssessment: true,
    noOfProblemSolvingQuestions: 4,
    cultureFitAssessment: false,
    personalityEvaluation: false,
    aiInterview: true,
    aiInterviewMode: "audio" as const,
  };

  it("counts applications, this week's, tests and interviews, and lists what needs doing by due date", async () => {
    const { user: talent, token } = await createTalent();
    const { stages } = createStages(SWITCHES);
    const pipelineConfig = await createAIConfig(recruiter, { ...SWITCHES, stages });
    const apply = async (
      name: string,
      stage: ScreeningStage,
      status = ApplicationStatus.Pending
    ) => {
      const job = await createJob(recruiter, await createRole(name), {
        organizationId,
        aiConfigId: pipelineConfig.id,
      });
      const application = await createApplication(talent, job, {
        stages,
        currentStage: stage,
        status,
      });
      return { job, application };
    };

    const test = await apply("Growth Manager", ScreeningStage.ProblemSolving);
    await testDataSource.query(`UPDATE "applications" SET "stageReachedAt" = $1 WHERE id = $2`, [
      JSON.stringify({ problem_solving: new Date().toISOString() }),
      test.application.id,
    ]);
    const interview = await apply("Product Designer", ScreeningStage.AiInterview);
    await testDataSource.getRepository(AiInterview).save({
      applicationId: interview.application.id,
      jobId: interview.job.id,
      talentId: talent.id,
      mode: "audio",
      status: "invited",
      invitedAt: new Date(),
    });
    const old = await apply(
      "UX Designer",
      ScreeningStage.ProblemSolving,
      ApplicationStatus.NotProceeding
    );
    await testDataSource.query(
      `UPDATE "applications" SET "createdAt" = NOW() - INTERVAL '10 days' WHERE id = $1`,
      [old.application.id]
    );

    const res = await fetchDashboard(token);

    expect(res.status).toBe(200);
    const data = apiData<{
      applications: { sent: number; sentThisWeek: number };
      tests: { toTake: number; nextDueAt: string | null };
      interviews: { toRecord: number; nextDueAt: string | null };
      todo: Array<{
        applicationId: string;
        jobTitle: string;
        company: { name: string } | null;
        step: { key: string; dueAt: string };
      }>;
    }>(res);
    expect(data.applications).toEqual({ sent: 3, sentThisWeek: 2 });
    expect(data.tests.toTake).toBe(1);
    expect(data.interviews.toRecord).toBe(1);
    expect(data.todo.map((item) => item.step.key)).toEqual(["problem_solving", "ai_interview"]);
    expect(data.todo[0]).toMatchObject({
      applicationId: test.application.id,
      jobTitle: "Growth Manager",
      company: { name: "Brightline" },
    });
    expect(data.tests.nextDueAt).toBe(data.todo[0]!.step.dueAt);
    expect(data.interviews.nextDueAt).toBe(data.todo[1]!.step.dueAt);
    expect(JSON.stringify(res.body)).not.toContain("minPrescreeningScore");
  });

  it("is empty for a talent with no applications", async () => {
    const { token } = await createTalent();
    const res = await fetchDashboard(token);
    expect(apiData(res)).toMatchObject({
      applications: { sent: 0, sentThisWeek: 0 },
      tests: { toTake: 0, nextDueAt: null },
      interviews: { toRecord: 0, nextDueAt: null },
      todo: [],
    });
  });
});
