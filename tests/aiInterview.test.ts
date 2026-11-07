import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createTalent,
  createRecruiter,
  createRole,
  createJob,
  createAIConfig,
  createApplication,
} from "./helpers/fixtures.js";
import { Application } from "../src/entities/Application.js";
import { AIConfig } from "../src/entities/AIConfig.js";
import { Job } from "../src/entities/Job.js";
import { AiInterview } from "../src/entities/AiInterview.js";
import { AiInterviewQuestion } from "../src/entities/AiInterviewQuestion.js";
import { ScreeningStage } from "../src/types/enums.js";
import { processNextStage } from "../src/services/applicationStage.js";
import { drainInFlightAiInterviews, startAiInterview } from "../src/services/aiInterview.js";
import * as AI from "../src/utils/integrations/openai.js";
import EmailService from "../src/utils/integrations/email/emailService.js";
import { CreateAiInterviews1789003000000 } from "../src/migrations/1789003000000-CreateAiInterviews.js";

const mockSendInvite = jest.fn();

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  generateAiInterviewQuestions: jest.fn(),
}));

const mockQuestions = AI.generateAiInterviewQuestions as jest.Mock;

const aiReply = (content: unknown) => ({
  message: { content: typeof content === "string" ? content : JSON.stringify(content) },
});

const FIVE = [
  "Tell us about a time you handled an angry customer.",
  "How do you keep track of many open tickets at once?",
  "What would you do if you could not answer a question on a call?",
  "How do you explain a technical fix to someone who is not technical?",
  "Why does this support role interest you?",
];

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  (EmailService as unknown as jest.Mock).mockImplementation(() => ({
    sendAiInterviewInvite: mockSendInvite,
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  }));
  mockSendInvite.mockResolvedValue(undefined);
  mockQuestions.mockResolvedValue(aiReply({ questions: FIVE }));
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

const interviewOnly = {
  prescreeningAssessment: false,
  cvSimilarity: false,
  personalizedAssessment: false,
  personalityEvaluation: false,
  aiInterview: true,
  aiInterviewMode: "audio_video",
} as Partial<AIConfig>;

describe("AI interview switch in the job's AI setup", () => {
  const baseBody = {
    name: "interview config",
    minPrescreeningScore: 60,
    cvSimilarity: true,
    minCvSimilarityScore: 50,
    personalizedAssessment: false,
    personalityEvaluation: false,
  };
  const createConfig = (token: string, body: Record<string, unknown>) =>
    request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...baseBody, ...body });

  async function recruiterJob() {
    const { user: recruiter, token } = await createRecruiter();
    const job = await createJob(recruiter, await createRole());
    return { token, job };
  }

  it("saves a job with the interview on, audio only or audio and video, and puts it in the pipeline", async () => {
    const { token, job } = await recruiterJob();
    const res = await createConfig(token, {
      jobId: job.id,
      cvSimilarity: true,
      aiInterview: true,
      aiInterviewMode: "audio",
    });
    expect(res.status).toBe(201);
    const saved = await testDataSource
      .getRepository(AIConfig)
      .findOneByOrFail({ id: res.body.data.aiConfig.id });
    expect(saved.aiInterview).toBe(true);
    expect(saved.aiInterviewMode).toBe("audio");
    expect(saved.stages).toMatchObject({ ai_interview: ScreeningStage.Completed });
  });

  it("keeps the interview off by default", async () => {
    const { token, job } = await recruiterJob();
    const res = await createConfig(token, { jobId: job.id, cvSimilarity: true });
    const saved = await testDataSource
      .getRepository(AIConfig)
      .findOneByOrFail({ id: res.body.data.aiConfig.id });
    expect(saved.aiInterview).toBe(false);
    expect(saved.aiInterviewMode).toBeNull();
    expect(Object.keys(saved.stages ?? {})).not.toContain("ai_interview");
  });

  it("refuses a mode other than audio or audio_video", async () => {
    const { token, job } = await recruiterJob();
    const res = await createConfig(token, {
      jobId: job.id,
      aiInterview: true,
      aiInterviewMode: "video",
    });
    expect(res.status).toBe(400);
  });

  it("refuses the interview switched on without a mode", async () => {
    const { token, job } = await recruiterJob();
    const res = await createConfig(token, { jobId: job.id, aiInterview: true });
    expect(res.status).toBe(400);
  });
});

describe("candidate reaching the AI interview stage", () => {
  async function setup(configOverrides: Partial<AIConfig> = interviewOnly) {
    const { user: recruiter } = await createRecruiter();
    const job = await createJob(recruiter, await createRole(), {
      jobBrief: "Customer support agent answering tickets and calls for a SaaS product.",
      requirements: "Two years in customer support.",
    });
    const aiConfig = await createAIConfig(recruiter, configOverrides);
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });
    const { user: talent, token } = await createTalent({ prescreeningScore: 75 });
    return { job, aiConfig, talent, token };
  }

  const interviewFor = (applicationId: string) =>
    testDataSource.getRepository(AiInterview).findOne({ where: { applicationId } });
  const questionsFor = (interviewId: string) =>
    testDataSource
      .getRepository(AiInterviewQuestion)
      .find({ where: { interviewId }, order: { position: "ASC" } });

  it("a test candidate who applies straight into the interview gets 5 questions and the email", async () => {
    const { job, talent, token } = await setup();
    const res = await request(app)
      .patch(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBeLessThan(300);
    await drainInFlightAiInterviews();

    const application = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ jobId: job.id, talentId: talent.id });
    expect(application.currentStage).toBe(ScreeningStage.AiInterview);

    const interview = await interviewFor(application.id);
    expect(interview).toMatchObject({
      jobId: job.id,
      talentId: talent.id,
      mode: "audio_video",
      status: "invited",
    });
    expect(interview!.invitedAt).toBeInstanceOf(Date);
    const questions = await questionsFor(interview!.id);
    expect(questions.map((q) => q.question)).toEqual(FIVE);
    expect(questions.map((q) => q.position)).toEqual([1, 2, 3, 4, 5]);

    const context = mockQuestions.mock.calls[0][0];
    expect(context.count).toBe(5);
    expect(context.jobBrief).toContain("Customer support agent");
    expect(context.requirements).toContain("Two years");

    expect(mockSendInvite).toHaveBeenCalledTimes(1);
    const invite = mockSendInvite.mock.calls[0][0];
    expect(invite.to).toBe(talent.email);
    expect(invite.mode).toBe("audio_video");
    expect(invite.ctaUrl).toContain(`/talentDashboard/applicationPipeline/${job.id}`);
  });

  it("starts the interview when an earlier stage hands over to it", async () => {
    const { job, aiConfig, talent } = await setup({
      ...interviewOnly,
      cvSimilarity: true,
      aiInterviewMode: "audio",
    });
    const application = await createApplication(talent, job, {
      stages: { cv_similarity: "ai_interview", ai_interview: "completed" },
      currentStage: ScreeningStage.CvSimilarity,
    });
    const moved = await processNextStage(
      talent,
      application,
      ScreeningStage.CvSimilarity,
      aiConfig
    );
    await testDataSource.getRepository(Application).save(moved);
    await drainInFlightAiInterviews();

    expect(moved.currentStage).toBe(ScreeningStage.AiInterview);
    const interview = await interviewFor(application.id);
    expect(interview).toMatchObject({ mode: "audio", status: "invited" });
    expect(await questionsFor(interview!.id)).toHaveLength(5);
    expect(mockSendInvite).toHaveBeenCalledTimes(1);
  });

  it("never starts a second interview for the same application", async () => {
    const { job, talent } = await setup();
    const application = await createApplication(talent, job, {
      stages: { ai_interview: "completed" },
      currentStage: ScreeningStage.AiInterview,
    });
    await startAiInterview(application.id);
    await startAiInterview(application.id);

    expect(await testDataSource.getRepository(AiInterview).count()).toBe(1);
    expect(await testDataSource.getRepository(AiInterviewQuestion).count()).toBe(5);
    expect(mockQuestions).toHaveBeenCalledTimes(1);
    expect(mockSendInvite).toHaveBeenCalledTimes(1);
  });

  it("sends no email and saves no questions when the AI fails", async () => {
    mockQuestions.mockRejectedValue(new Error("AI down"));
    const { job, talent } = await setup();
    const application = await createApplication(talent, job, {
      stages: { ai_interview: "completed" },
      currentStage: ScreeningStage.AiInterview,
    });
    await expect(startAiInterview(application.id)).resolves.toBeUndefined();

    const interview = await interviewFor(application.id);
    expect(interview!.status).toBe("failed");
    expect(await questionsFor(interview!.id)).toHaveLength(0);
    expect(mockSendInvite).not.toHaveBeenCalled();
  });

  it("treats a reply without 5 usable questions as a failure", async () => {
    mockQuestions.mockResolvedValue(aiReply({ questions: FIVE.slice(0, 3) }));
    const { job, talent } = await setup();
    const application = await createApplication(talent, job, {
      stages: { ai_interview: "completed" },
      currentStage: ScreeningStage.AiInterview,
    });
    await startAiInterview(application.id);

    const interview = await interviewFor(application.id);
    expect(interview!.status).toBe("failed");
    expect(await questionsFor(interview!.id)).toHaveLength(0);
    expect(mockSendInvite).not.toHaveBeenCalled();
  });

  it("keeps the 5 questions when the invite email fails", async () => {
    mockSendInvite.mockRejectedValue(new Error("mail down"));
    const { job, talent } = await setup();
    const application = await createApplication(talent, job, {
      stages: { ai_interview: "completed" },
      currentStage: ScreeningStage.AiInterview,
    });
    await startAiInterview(application.id);

    const interview = await interviewFor(application.id);
    expect(interview!.status).toBe("ready");
    expect(interview!.invitedAt).toBeNull();
    expect(await questionsFor(interview!.id)).toHaveLength(5);
  });

  it("does nothing for jobs without the interview", async () => {
    const { job, talent } = await setup({
      ...interviewOnly,
      aiInterview: false,
      cvSimilarity: true,
    });
    const application = await createApplication(talent, job, {
      stages: { cv_similarity: "completed" },
      currentStage: ScreeningStage.CvSimilarity,
    });
    await startAiInterview(application.id);
    expect(await testDataSource.getRepository(AiInterview).count()).toBe(0);
    expect(mockQuestions).not.toHaveBeenCalled();
  });
});

describe("CreateAiInterviews migration", () => {
  const tableExists = async (name: string) => {
    const rows = await testDataSource.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
      [name]
    );
    return rows.length > 0;
  };
  const columnExists = async (table: string, column: string) => {
    const rows = await testDataSource.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column]
    );
    return rows.length > 0;
  };
  const stageValues = async () =>
    (
      await testDataSource.query(
        `SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'applications_currentstage_enum'`
      )
    ).map((r: { v: string }) => r.v);

  it("creates the interview tables, switch columns and stage, and down removes them", async () => {
    const runner = testDataSource.createQueryRunner();
    const migration = new CreateAiInterviews1789003000000();
    try {
      await runner.query(`DROP TABLE IF EXISTS "ai_interview_questions"`);
      await runner.query(`DROP TABLE IF EXISTS "ai_interviews"`);
      await runner.query(`ALTER TABLE "ai_configs" DROP COLUMN "aiInterview"`);
      await runner.query(`ALTER TABLE "ai_configs" DROP COLUMN "aiInterviewMode"`);
      await runner.query(`ALTER TABLE "applications" ALTER COLUMN "currentStage" DROP DEFAULT`);
      await runner.query(
        `ALTER TYPE "public"."applications_currentstage_enum" RENAME TO "applications_currentstage_enum_new"`
      );
      await runner.query(
        `CREATE TYPE "public"."applications_currentstage_enum" AS ENUM('prescreening', 'cv_similarity', 'personalized', 'personality', 'completed')`
      );
      await runner.query(
        `ALTER TABLE "applications" ALTER COLUMN "currentStage" TYPE "public"."applications_currentstage_enum" USING "currentStage"::text::"public"."applications_currentstage_enum"`
      );
      await runner.query(`DROP TYPE "public"."applications_currentstage_enum_new"`);
      await runner.query(
        `ALTER TABLE "applications" ALTER COLUMN "currentStage" SET DEFAULT 'personality'`
      );

      await migration.up(runner);
      expect(await tableExists("ai_interviews")).toBe(true);
      expect(await tableExists("ai_interview_questions")).toBe(true);
      expect(await columnExists("ai_configs", "aiInterview")).toBe(true);
      expect(await columnExists("ai_configs", "aiInterviewMode")).toBe(true);
      expect(await stageValues()).toContain("ai_interview");

      await migration.down(runner);
      expect(await tableExists("ai_interviews")).toBe(false);
      expect(await tableExists("ai_interview_questions")).toBe(false);
      expect(await columnExists("ai_configs", "aiInterview")).toBe(false);
      expect(await columnExists("ai_configs", "aiInterviewMode")).toBe(false);
      expect(await stageValues()).not.toContain("ai_interview");

      await migration.up(runner);
      expect(await tableExists("ai_interviews")).toBe(true);
    } finally {
      await runner.release();
    }
  });
});
