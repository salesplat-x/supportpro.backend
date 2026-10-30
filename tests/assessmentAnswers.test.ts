import request from "supertest";
import type { QueryRunner } from "typeorm";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createRecruiter,
  createCompleteTalent,
  createAIConfig,
  createApplication,
  createJob,
  createRole,
  createQuestion,
} from "./helpers/fixtures.js";
import { Application } from "../src/entities/Application.js";
import { Answer } from "../src/entities/Answer.js";
import type { AIConfig } from "../src/entities/AIConfig.js";
import { Question } from "../src/entities/Question.js";
import { JobStatus, QuestionType } from "../src/types/enums.js";
import * as AI from "../src/utils/integrations/openai.js";
import { apiData } from "./helpers/http.js";
import { AddAssessmentScoresToApplications1789001100000 } from "../src/migrations/1789001100000-AddAssessmentScoresToApplications.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  gradeCompanyAssessmentAnswers: jest.fn(),
}));

const mockGrade = AI.gradeCompanyAssessmentAnswers as jest.Mock<
  Promise<unknown>,
  [AI.GradeCompanyAssessmentContext]
>;

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

type Grade = { questionId: string; score: unknown; feedback?: string };
const gradesReply = (grades: Grade[]) => ({ message: { content: JSON.stringify({ grades }) } });

const SETTINGS = {
  [QuestionType.ProblemSolving]: {
    path: "problem-solving",
    assigned: "problemSolvingQuestions",
    score: "problemSolvingScore",
    flag: "problemSolvingAssessment",
  },
  [QuestionType.CultureFit]: {
    path: "culture-fit",
    assigned: "cultureFitQuestions",
    score: "cultureFitScore",
    flag: "cultureFitAssessment",
  },
} as const;

type AssessmentType = keyof typeof SETTINGS;

async function servedApplicant(type: AssessmentType, configOverrides: Partial<AIConfig> = {}) {
  const { user: recruiter } = await createRecruiter();
  const config = await createAIConfig(recruiter, {
    problemSolvingAssessment: true,
    noOfProblemSolvingQuestions: 3,
    cultureFitAssessment: true,
    noOfCultureFitQuestions: 3,
    ...configOverrides,
  });
  const job = await createJob(recruiter, await createRole(), { aiConfigId: config.id });
  const questions: Question[] = [];
  for (let i = 1; i <= 3; i++) {
    questions.push(
      await createQuestion(
        type,
        { jobId: job.id },
        {
          question: `Assessment question ${i}: how would you handle it?`,
          category: type === QuestionType.CultureFit ? "Ownership" : "analytical",
          criteria: `Criteria ${i}: what a strong answer shows.`,
        }
      )
    );
  }
  const { user: talent, token } = await createCompleteTalent();
  const application = await createApplication(talent, job, {
    [SETTINGS[type].assigned]: questions.map((q) => q.id),
  } as Partial<Application>);
  return { job, talent, token, application, questions };
}

const answersFor = (questions: Question[]) =>
  Object.fromEntries(questions.map((q, i) => [q.id, `My answer number ${i + 1}, step by step.`]));

const submit = (token: string, type: AssessmentType, body: Record<string, unknown>) =>
  request(app)
    .post(`/v1/questions/answer/${SETTINGS[type].path}`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);

const reloadApplication = (id: string) =>
  testDataSource.getRepository(Application).findOneByOrFail({ id });

const storedAnswer = (userId: string, jobId: string, questionType: QuestionType) =>
  testDataSource.getRepository(Answer).findOne({ where: { userId, jobId, questionType } });

const errorMessage = (res: request.Response): string =>
  (res.body as { error: { message: string } }).error.message;

describe.each([QuestionType.ProblemSolving, QuestionType.CultureFit] as const)(
  "POST /v1/questions/answer/%s",
  (type) => {
    const scoreField = SETTINGS[type].score;

    it("Day 4 proof: scores a test job's applicant against the criteria → 200", async () => {
      const { job, talent, token, application, questions } = await servedApplicant(type);
      mockGrade.mockResolvedValueOnce(
        gradesReply([
          { questionId: questions[0]!.id, score: 5, feedback: "Excellent." },
          { questionId: questions[1]!.id, score: 3, feedback: "Partly." },
          { questionId: questions[2]!.id, score: 4, feedback: "Good." },
        ])
      );

      const res = await submit(token, type, { jobId: job.id, answers: answersFor(questions) });
      expect(res.status).toBe(200);
      expect(apiData(res)).toEqual({ submitted: true, questionType: type, answered: 3 });

      const saved = await reloadApplication(application.id);
      expect(saved[scoreField]).toBe(80);

      const answer = await storedAnswer(talent.id, job.id, type);
      expect(answer).not.toBeNull();
      const byId = new Map(answer!.responses.map((r) => [r.questionId, r]));
      expect(byId.get(questions[1]!.id)).toMatchObject({
        answer: "My answer number 2, step by step.",
        score: 3,
        feedback: "Partly.",
      });
    });

    it("sends each question's criteria and the candidate's answer to the grader", async () => {
      const { job, token, questions } = await servedApplicant(type);
      mockGrade.mockResolvedValueOnce(
        gradesReply(questions.map((q) => ({ questionId: q.id, score: 4, feedback: "ok" })))
      );
      await submit(token, type, { jobId: job.id, answers: answersFor(questions) });

      expect(mockGrade).toHaveBeenCalledTimes(1);
      const context = mockGrade.mock.calls[0]![0];
      expect(context.type).toBe(type);
      expect(context.items).toHaveLength(3);
      const item = context.items.find((i) => i.questionId === questions[0]!.id)!;
      expect(item.criteria).toBe("Criteria 1: what a strong answer shows.");
      expect(item.answer).toBe("My answer number 1, step by step.");
      if (type === QuestionType.CultureFit) {
        expect(item.companyValue).toBe("Ownership");
      }
    });

    it("asks again only for answers the AI didn't grade, then scores them all", async () => {
      const { job, token, application, questions } = await servedApplicant(type);
      mockGrade
        .mockResolvedValueOnce(
          gradesReply([
            { questionId: questions[0]!.id, score: 5 },
            { questionId: questions[1]!.id, score: 9 },
          ])
        )
        .mockResolvedValueOnce(
          gradesReply([
            { questionId: questions[1]!.id, score: 2 },
            { questionId: questions[2]!.id, score: 2 },
          ])
        );
      const res = await submit(token, type, { jobId: job.id, answers: answersFor(questions) });
      expect(res.status).toBe(200);
      expect(mockGrade).toHaveBeenCalledTimes(2);
      const retryItems = mockGrade.mock.calls[1]![0].items;
      expect(retryItems.map((i) => i.questionId).sort()).toEqual(
        [questions[1]!.id, questions[2]!.id].sort()
      );
      expect((await reloadApplication(application.id))[scoreField]).toBe(60);
    });

    it("unusable AI replies twice → 502, nothing saved, and the candidate can try again", async () => {
      const { job, talent, token, application, questions } = await servedApplicant(type);
      mockGrade
        .mockResolvedValueOnce({ message: { content: "Sorry, I can't do that." } })
        .mockRejectedValueOnce(new Error("timeout"));
      const res = await submit(token, type, { jobId: job.id, answers: answersFor(questions) });
      expect(res.status).toBe(502);
      expect(errorMessage(res)).toMatch(/couldn't score/i);
      expect((await reloadApplication(application.id))[scoreField]).toBeNull();
      expect(await storedAnswer(talent.id, job.id, type)).toBeNull();

      mockGrade.mockResolvedValueOnce(
        gradesReply(questions.map((q) => ({ questionId: q.id, score: 5 })))
      );
      const retry = await submit(token, type, { jobId: job.id, answers: answersFor(questions) });
      expect(retry.status).toBe(200);
      expect((await reloadApplication(application.id))[scoreField]).toBe(100);
    });

    it("a second submission → 409 and the first score stays", async () => {
      const { job, token, application, questions } = await servedApplicant(type);
      mockGrade.mockResolvedValue(
        gradesReply(questions.map((q) => ({ questionId: q.id, score: 1 })))
      );
      expect(
        (await submit(token, type, { jobId: job.id, answers: answersFor(questions) })).status
      ).toBe(200);
      const again = await submit(token, type, { jobId: job.id, answers: answersFor(questions) });
      expect(again.status).toBe(409);
      expect((await reloadApplication(application.id))[scoreField]).toBe(20);
      expect(mockGrade).toHaveBeenCalledTimes(1);
    });

    it("missing an answer to one of the candidate's questions → 400", async () => {
      const { job, token, questions } = await servedApplicant(type);
      const answers = answersFor(questions);
      delete answers[questions[2]!.id];
      const res = await submit(token, type, { jobId: job.id, answers });
      expect(res.status).toBe(400);
      expect(mockGrade).not.toHaveBeenCalled();
    });

    it("answering a question the candidate wasn't given → 400", async () => {
      const { job, token, questions } = await servedApplicant(type);
      const res = await submit(token, type, {
        jobId: job.id,
        answers: { ...answersFor(questions), "5f0c2a5e-7d1b-4c3e-9a8f-2b6d4e1f0a99": "extra" },
      });
      expect(res.status).toBe(400);
      expect(mockGrade).not.toHaveBeenCalled();
    });

    it("a blank answer → 400", async () => {
      const { job, token, questions } = await servedApplicant(type);
      const res = await submit(token, type, {
        jobId: job.id,
        answers: { ...answersFor(questions), [questions[0]!.id]: "   " },
      });
      expect(res.status).toBe(400);
    });

    it("before the candidate has loaded their questions → 400", async () => {
      const { job, token, application, questions } = await servedApplicant(type);
      await testDataSource.query(
        `UPDATE "applications" SET "${SETTINGS[type].assigned}" = NULL WHERE id = $1`,
        [application.id]
      );
      const res = await submit(token, type, { jobId: job.id, answers: answersFor(questions) });
      expect(res.status).toBe(400);
    });

    it("the test is switched off for this job → 400", async () => {
      const { job, token, questions } = await servedApplicant(type, {
        [SETTINGS[type].flag]: false,
      } as Partial<AIConfig>);
      const res = await submit(token, type, { jobId: job.id, answers: answersFor(questions) });
      expect(res.status).toBe(400);
      expect(errorMessage(res)).toMatch(/not switched on/i);
    });

    it("a closed job → 400", async () => {
      const { job, token, questions } = await servedApplicant(type);
      const { Job } = await import("../src/entities/Job.js");
      await testDataSource.getRepository(Job).update({ id: job.id }, { status: JobStatus.Closed });
      const res = await submit(token, type, { jobId: job.id, answers: answersFor(questions) });
      expect(res.status).toBe(400);
    });

    it("a recruiter can't submit candidate answers → 403", async () => {
      const { job, questions } = await servedApplicant(type);
      const { token: recruiterToken } = await createRecruiter();
      const res = await submit(recruiterToken, type, {
        jobId: job.id,
        answers: answersFor(questions),
      });
      expect(res.status).toBe(403);
    });

    it("bad body → 400", async () => {
      const { token } = await servedApplicant(type);
      expect((await submit(token, type, { jobId: "nope", answers: {} })).status).toBe(400);
    });
  }
);

describe("AddAssessmentScoresToApplications migration", () => {
  it("adds the two nullable score columns and removes them on down", async () => {
    const queries: string[] = [];
    const runner = {
      query: (sql: string) => Promise.resolve(void queries.push(sql)),
    } as unknown as QueryRunner;
    await new AddAssessmentScoresToApplications1789001100000().up(runner);
    expect(queries).toEqual([
      `ALTER TABLE "applications" ADD "problemSolvingScore" double precision`,
      `ALTER TABLE "applications" ADD "cultureFitScore" double precision`,
    ]);
    queries.length = 0;
    await new AddAssessmentScoresToApplications1789001100000().down(runner);
    expect(queries).toEqual([
      `ALTER TABLE "applications" DROP COLUMN "cultureFitScore"`,
      `ALTER TABLE "applications" DROP COLUMN "problemSolvingScore"`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Concurrency, retries and bad input
// ---------------------------------------------------------------------------

describe("submitting under concurrency and failure", () => {
  /** Holds every grading reply until `expected` calls are waiting, so requests overlap. */
  const overlappingGrades = (expected: number, score = 4) => {
    let waiting = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockGrade.mockImplementation(async ({ items }) => {
      if (++waiting === expected) release();
      await gate;
      return gradesReply(items.map((item) => ({ questionId: item.questionId, score })));
    });
  };

  it("two overlapping submissions of the same test store one score and one answer row", async () => {
    const { token, job, talent, application, questions } = await servedApplicant(
      QuestionType.ProblemSolving
    );
    overlappingGrades(2);

    const [a, b] = await Promise.all([
      submit(token, QuestionType.ProblemSolving, { jobId: job.id, answers: answersFor(questions) }),
      submit(token, QuestionType.ProblemSolving, { jobId: job.id, answers: answersFor(questions) }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const rows = await testDataSource.getRepository(Answer).find({
      where: { userId: talent.id, jobId: job.id, questionType: QuestionType.ProblemSolving },
    });
    expect(rows).toHaveLength(1);
    expect((await reloadApplication(application.id)).problemSolvingScore).toBe(80);
  });

  it("overlapping problem-solving and culture-fit submissions keep both scores", async () => {
    const { user: recruiter } = await createRecruiter();
    const config = await createAIConfig(recruiter, {
      problemSolvingAssessment: true,
      noOfProblemSolvingQuestions: 2,
      cultureFitAssessment: true,
      noOfCultureFitQuestions: 2,
    });
    const job = await createJob(recruiter, await createRole(), { aiConfigId: config.id });
    const make = (type: QuestionType, i: number) =>
      createQuestion(type, { jobId: job.id }, { question: `Question ${type} ${i}: what next?` });
    const ps = [
      await make(QuestionType.ProblemSolving, 1),
      await make(QuestionType.ProblemSolving, 2),
    ];
    const cf = [await make(QuestionType.CultureFit, 1), await make(QuestionType.CultureFit, 2)];
    const { token, user: talent } = await createCompleteTalent();
    const application = await createApplication(talent, job, {
      problemSolvingQuestions: ps.map((q) => q.id),
      cultureFitQuestions: cf.map((q) => q.id),
    } as Partial<Application>);
    overlappingGrades(2, 5);

    const [a, b] = await Promise.all([
      submit(token, QuestionType.ProblemSolving, { jobId: job.id, answers: answersFor(ps) }),
      submit(token, QuestionType.CultureFit, { jobId: job.id, answers: answersFor(cf) }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    const saved = await reloadApplication(application.id);
    expect(saved.problemSolvingScore).toBe(100);
    expect(saved.cultureFitScore).toBe(100);
  });

  it("does not call the grader a second time after the call itself fails", async () => {
    const { token, job, application, questions } = await servedApplicant(QuestionType.CultureFit);
    mockGrade.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));

    const res = await submit(token, QuestionType.CultureFit, {
      jobId: job.id,
      answers: answersFor(questions),
    });

    expect(res.status).toBe(502);
    expect(mockGrade).toHaveBeenCalledTimes(1);
    expect((await reloadApplication(application.id)).cultureFitScore).toBeNull();
  });

  it("after a recruiter deletes one of their questions, the candidate reloads and submits", async () => {
    const { token, job, application, questions } = await servedApplicant(
      QuestionType.ProblemSolving
    );
    await testDataSource.getRepository(Question).delete({ id: questions[0]!.id });

    const stale = await submit(token, QuestionType.ProblemSolving, {
      jobId: job.id,
      answers: answersFor(questions.slice(1)),
    });
    expect(stale.status).toBe(400);
    expect(errorMessage(stale)).toMatch(/reload/i);

    const reload = await request(app)
      .get("/v1/questions/candidate/problem-solving")
      .query({ jobId: job.id })
      .set("Authorization", `Bearer ${token}`);
    const served = apiData<{ questions: Question[] }>(reload).questions;
    expect(served.map((q) => q.id).sort()).toEqual(
      questions
        .slice(1)
        .map((q) => q.id)
        .sort()
    );

    mockGrade.mockImplementation(async ({ items }) =>
      gradesReply(items.map((item) => ({ questionId: item.questionId, score: 5 })))
    );
    const res = await submit(token, QuestionType.ProblemSolving, {
      jobId: job.id,
      answers: answersFor(served),
    });

    expect(res.status).toBe(200);
    expect((await reloadApplication(application.id)).problemSolvingScore).toBe(100);
  });

  it("a jobId sent as a list → 400", async () => {
    const { token, job, questions } = await servedApplicant(QuestionType.ProblemSolving);

    const res = await submit(token, QuestionType.ProblemSolving, {
      jobId: [job.id],
      answers: answersFor(questions),
    });

    expect(res.status).toBe(400);
    expect(mockGrade).not.toHaveBeenCalled();
  });
});
