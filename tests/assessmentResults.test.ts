import request from "supertest";
import { In } from "typeorm";
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
  createOrganization,
  createQuestion,
  createAdmin,
} from "./helpers/fixtures.js";
import { Application } from "../src/entities/Application.js";
import { User } from "../src/entities/User.js";
import { Job } from "../src/entities/Job.js";
import { Notification } from "../src/entities/Notification.js";
import { AiRecommendation } from "../src/entities/AiRecommendation.js";
import { Answer } from "../src/entities/Answer.js";
import {
  ApplicationStatus,
  ScreeningStage,
  MatchVerdict,
  MatchRecommendation,
  QuestionType,
} from "../src/types/enums.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  assessApplicationMatch: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({ verdict: "high", reasoning: "Strong overall fit." }),
    },
  }),
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

const seedGraded = async (
  talentId: string,
  jobId: string,
  type: QuestionType.ProblemSolving | QuestionType.CultureFit,
  questionId: string,
  answer: string,
  score: number,
  feedback: string
) => {
  const repo = testDataSource.getRepository(Answer);
  await repo.save(
    repo.create({
      userId: talentId,
      jobId,
      questionType: type,
      responses: [{ questionId, answer, score, feedback }],
    })
  );
};

const setupScoredApplication = async () => {
  const { user: recruiter, token: recruiterToken } = await createRecruiter();
  const role = await createRole();
  const job = await createJob(recruiter, role);
  const { user: talent, token: talentToken } = await createTalent();
  const app_ = await createApplication(talent, job);
  const ps = await createQuestion(
    QuestionType.ProblemSolving,
    { jobId: job.id },
    {
      question: "A key client churns overnight. What do you do first?",
      criteria: "Triage, then root cause",
    }
  );
  const cf = await createQuestion(
    QuestionType.CultureFit,
    { jobId: job.id },
    { question: "Tell us about a time you put the customer first.", criteria: "Shows ownership" }
  );
  await seedGraded(
    talent.id,
    job.id,
    QuestionType.ProblemSolving,
    ps.id,
    "Call them, then find the cause.",
    4,
    "Clear triage, light on root cause."
  );
  await seedGraded(
    talent.id,
    job.id,
    QuestionType.CultureFit,
    cf.id,
    "I stayed late to fix a refund.",
    5,
    "Strong ownership."
  );
  await testDataSource.query(
    `UPDATE "applications" SET "problemSolvingScore" = 80, "cultureFitScore" = 100 WHERE id = $1`,
    [app_.id]
  );
  return { recruiter, recruiterToken, talent, talentToken, job, app_ };
};

describe("Day 5 — recruiter reads problem-solving and culture-fit results", () => {
  it("the job's recruiter sees both scores and the graded answers with feedback", async () => {
    const { recruiterToken, app_ } = await setupScoredApplication();
    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${recruiterToken}`);

    expect(res.status).toBe(200);
    const a = res.body.data.application;
    expect(a.problemSolvingScore).toBe(80);
    expect(a.cultureFitScore).toBe(100);
    expect(a.problemSolvingAnswers).toEqual([
      {
        question: "A key client churns overnight. What do you do first?",
        answer: "Call them, then find the cause.",
        score: 4,
        maxScore: 5,
        feedback: "Clear triage, light on root cause.",
      },
    ]);
    expect(a.cultureFitAnswers).toEqual([
      expect.objectContaining({
        question: "Tell us about a time you put the customer first.",
        answer: "I stayed late to fix a refund.",
        score: 5,
        maxScore: 5,
        feedback: "Strong ownership.",
      }),
    ]);
  });

  it("shows the recruiter the options, the chosen option and the correct one for multiple-choice answers", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const job = await createJob(recruiter, await createRole());
    const { user: talent } = await createTalent();
    const app_ = await createApplication(talent, job);
    const options = ["Call them", "Email them", "Wait", "Escalate"];
    const ps = await createQuestion(
      QuestionType.ProblemSolving,
      { jobId: job.id },
      { question: "A key client churns. What first?", options, correctOption: 0 }
    );
    const repo = testDataSource.getRepository(Answer);
    await repo.save(
      repo.create({
        userId: talent.id,
        jobId: job.id,
        questionType: QuestionType.ProblemSolving,
        responses: [{ questionId: ps.id, answer: "Wait", selectedOption: 2, score: 0 }],
      })
    );

    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${recruiterToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.application.problemSolvingAnswers).toEqual([
      {
        question: "A key client churns. What first?",
        answer: "Wait",
        score: 0,
        maxScore: 5,
        feedback: null,
        options,
        selectedOption: 2,
        correctOption: 0,
      },
    ]);
  });

  it("returns empty answer lists and null scores when the candidate hasn't taken the tests", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const app_ = await createApplication(talent, job);

    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.application.problemSolvingScore).toBeNull();
    expect(res.body.data.application.cultureFitScore).toBeNull();
    expect(res.body.data.application.problemSolvingAnswers).toEqual([]);
    expect(res.body.data.application.cultureFitAnswers).toEqual([]);
  });

  it("a recruiter from another company still gets 403", async () => {
    const { app_ } = await setupScoredApplication();
    const { token: outsider } = await createRecruiter();
    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${outsider}`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("Strong ownership.");
  });
});

describe("Day 5 — candidates never see their scores or the grading", () => {
  it("tells the candidate which tests they have already submitted, without the score", async () => {
    const { talentToken, app_ } = await setupScoredApplication();
    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${talentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.application.problemSolvingSubmitted).toBe(true);
    expect(res.body.data.application.cultureFitSubmitted).toBe(true);
  });

  it("says a test is not yet submitted when there is no score", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent, token } = await createTalent();
    const app_ = await createApplication(talent, job);

    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.data.application.problemSolvingSubmitted).toBe(false);
    expect(res.body.data.application.cultureFitSubmitted).toBe(false);
  });

  it("hides scores, graded answers and feedback from the candidate's own application", async () => {
    const { talentToken, app_ } = await setupScoredApplication();
    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${talentToken}`);

    expect(res.status).toBe(200);
    const a = res.body.data.application;
    expect(a).not.toHaveProperty("problemSolvingScore");
    expect(a).not.toHaveProperty("cultureFitScore");
    expect(a).not.toHaveProperty("problemSolvingAnswers");
    expect(a).not.toHaveProperty("cultureFitAnswers");
    expect(JSON.stringify(res.body)).not.toContain("Strong ownership.");
  });

  it("hides the scores from the candidate's application list", async () => {
    const { talentToken } = await setupScoredApplication();
    const res = await request(app)
      .get("/v1/applications")
      .set("Authorization", `Bearer ${talentToken}`);

    expect(res.status).toBe(200);
    const list = res.body.data.applications ?? res.body.data;
    expect(list.length).toBe(1);
    expect(list[0]).not.toHaveProperty("problemSolvingScore");
    expect(list[0]).not.toHaveProperty("cultureFitScore");
  });

  it("still shows the scores in the recruiter's application list", async () => {
    const { recruiterToken } = await setupScoredApplication();
    const res = await request(app)
      .get("/v1/applications")
      .set("Authorization", `Bearer ${recruiterToken}`);

    expect(res.status).toBe(200);
    const list = res.body.data.applications ?? res.body.data;
    expect(list[0].problemSolvingScore).toBe(80);
    expect(list[0].cultureFitScore).toBe(100);
  });
});
