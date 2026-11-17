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
import { ApplicationStatus, ScreeningStage } from "../src/types/enums.js";
import { createStages } from "../src/services/aiConfig.js";
import { apiData } from "./helpers/http.js";
import { AiInterview } from "../src/entities/AiInterview.js";
import type { User } from "../src/entities/User.js";

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

let recruiter: User;
let organizationId: string;

const fetchDashboard = (token: string) =>
  request(app).get("/v1/user/dashboard").set("Authorization", `Bearer ${token}`);

beforeEach(async () => {
  recruiter = (await createRecruiter()).user;
  const org = await createOrganization(recruiter, { name: "Brightline" });
  organizationId = org.id;
});

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

describe("GET /v1/user/dashboard", () => {
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
    expect(Object.keys(data).sort()).toEqual(["applications", "interviews", "tests", "todo"]);
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
    expect(apiData(res)).toEqual({
      applications: { sent: 0, sentThisWeek: 0 },
      tests: { toTake: 0, nextDueAt: null },
      interviews: { toRecord: 0, nextDueAt: null },
      todo: [],
    });
  });

  it("is talent-only", async () => {
    const { token } = await createRecruiter();

    expect((await fetchDashboard(token)).status).toBe(403);
  });
});
