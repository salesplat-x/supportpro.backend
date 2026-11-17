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
import { apiData } from "./helpers/http.js";
import { AddAssessmentScoresToApplications1789001100000 } from "../src/migrations/1789001100000-AddAssessmentScoresToApplications.js";
import { AddMultipleChoiceToQuestions1789004300000 } from "../src/migrations/1789004300000-AddMultipleChoiceToQuestions.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
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

const OPTIONS = ["First option", "Second option", "Third option", "Fourth option"];

const choiceQuestion = (type: QuestionType, jobId: string, i: number, correctOption = i % 4) =>
  createQuestion(
    type,
    { jobId },
    {
      question: `Assessment question ${type} ${i}: which would you pick?`,
      category: type === QuestionType.CultureFit ? "Ownership" : "analytical",
      criteria: `Option ${correctOption} is right.`,
      options: OPTIONS,
      correctOption,
    }
  );

async function servedApplicant(type: AssessmentType, configOverrides: Partial<AIConfig> = {}) {
  const { user: recruiter } = await createRecruiter();
  const config = await createAIConfig(recruiter, {
    problemSolvingAssessment: true,
    noOfProblemSolvingQuestions: 4,
    cultureFitAssessment: true,
    noOfCultureFitQuestions: 4,
    ...configOverrides,
  });
  const job = await createJob(recruiter, await createRole(), { aiConfigId: config.id });
  const questions: Question[] = [];
  for (let i = 0; i < 4; i++) {
    questions.push(await choiceQuestion(type, job.id, i));
  }
  const { user: talent, token } = await createCompleteTalent();
  const application = await createApplication(talent, job, {
    [SETTINGS[type].assigned]: questions.map((q) => q.id),
  } as Partial<Application>);
  return { job, talent, token, application, questions };
}

const correctAnswers = (questions: Question[]) =>
  Object.fromEntries(questions.map((q) => [q.id, q.correctOption!]));

const answersWithWrong = (questions: Question[], wrong: number) =>
  Object.fromEntries(
    questions.map((q, i) => [q.id, i < wrong ? (q.correctOption! + 1) % 4 : q.correctOption!])
  );

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

    it("scores the share of correct options and stores each choice → 200", async () => {
      const { job, talent, token, application, questions } = await servedApplicant(type);

      const res = await submit(token, type, {
        jobId: job.id,
        answers: answersWithWrong(questions, 1),
      });
      expect(res.status).toBe(200);
      expect(apiData(res)).toEqual({ submitted: true, questionType: type, answered: 4 });

      expect((await reloadApplication(application.id))[scoreField]).toBe(75);

      const answer = await storedAnswer(talent.id, job.id, type);
      const byId = new Map(answer!.responses.map((r) => [r.questionId, r]));
      expect(byId.get(questions[0]!.id)).toMatchObject({
        answer: OPTIONS[(questions[0]!.correctOption! + 1) % 4],
        selectedOption: (questions[0]!.correctOption! + 1) % 4,
        score: 0,
      });
      expect(byId.get(questions[1]!.id)).toMatchObject({
        answer: OPTIONS[questions[1]!.correctOption!],
        selectedOption: questions[1]!.correctOption,
        score: 5,
      });
    });

    it("rounds the score to a whole percentage", async () => {
      const { job, token, application, questions } = await servedApplicant(type, {
        [SETTINGS[type].assigned === "problemSolvingQuestions"
          ? "noOfProblemSolvingQuestions"
          : "noOfCultureFitQuestions"]: 3,
      } as Partial<AIConfig>);
      await testDataSource.query(
        `UPDATE "applications" SET "${SETTINGS[type].assigned}" = $1 WHERE id = $2`,
        [
          questions
            .slice(0, 3)
            .map((q) => q.id)
            .join(","),
          application.id,
        ]
      );
      const res = await submit(token, type, {
        jobId: job.id,
        answers: answersWithWrong(questions.slice(0, 3), 1),
      });
      expect(res.status).toBe(200);
      expect((await reloadApplication(application.id))[scoreField]).toBe(67);
    });

    it("a second submission → 409 and the first score stays", async () => {
      const { job, token, application, questions } = await servedApplicant(type);
      expect(
        (await submit(token, type, { jobId: job.id, answers: answersWithWrong(questions, 4) }))
          .status
      ).toBe(200);
      const again = await submit(token, type, {
        jobId: job.id,
        answers: correctAnswers(questions),
      });
      expect(again.status).toBe(409);
      expect((await reloadApplication(application.id))[scoreField]).toBe(0);
    });

    it("missing an answer to one of the candidate's questions → 400", async () => {
      const { job, token, questions } = await servedApplicant(type);
      const answers = correctAnswers(questions);
      delete answers[questions[2]!.id];
      expect((await submit(token, type, { jobId: job.id, answers })).status).toBe(400);
    });

    it("answering a question the candidate wasn't given → 400", async () => {
      const { job, token, questions } = await servedApplicant(type);
      const res = await submit(token, type, {
        jobId: job.id,
        answers: { ...correctAnswers(questions), "5f0c2a5e-7d1b-4c3e-9a8f-2b6d4e1f0a99": 0 },
      });
      expect(res.status).toBe(400);
    });

    it.each([4, -1, 1.5, "1", "my answer", null])("an answer of %p → 400", async (bad) => {
      const { job, token, application, questions } = await servedApplicant(type);
      const res = await submit(token, type, {
        jobId: job.id,
        answers: { ...correctAnswers(questions), [questions[0]!.id]: bad },
      });
      expect(res.status).toBe(400);
      expect((await reloadApplication(application.id))[scoreField]).toBeNull();
    });

    it("an assigned question without options (an old open-ended one) → 400 asking to reload", async () => {
      const { job, token, application, questions } = await servedApplicant(type);
      await testDataSource
        .getRepository(Question)
        .update({ id: questions[1]!.id }, { options: null, correctOption: null });
      const res = await submit(token, type, { jobId: job.id, answers: correctAnswers(questions) });
      expect(res.status).toBe(400);
      expect(errorMessage(res)).toMatch(/reload/i);
      expect((await reloadApplication(application.id))[scoreField]).toBeNull();
    });

    it("before the candidate has loaded their questions → 400", async () => {
      const { job, token, application, questions } = await servedApplicant(type);
      await testDataSource.query(
        `UPDATE "applications" SET "${SETTINGS[type].assigned}" = NULL WHERE id = $1`,
        [application.id]
      );
      expect(
        (await submit(token, type, { jobId: job.id, answers: correctAnswers(questions) })).status
      ).toBe(400);
    });

    it("the test is switched off for this job → 400", async () => {
      const { job, token, questions } = await servedApplicant(type, {
        [SETTINGS[type].flag]: false,
      } as Partial<AIConfig>);
      const res = await submit(token, type, { jobId: job.id, answers: correctAnswers(questions) });
      expect(res.status).toBe(400);
      expect(errorMessage(res)).toMatch(/not switched on/i);
    });

    it("a closed job → 400", async () => {
      const { job, token, questions } = await servedApplicant(type);
      const { Job } = await import("../src/entities/Job.js");
      await testDataSource.getRepository(Job).update({ id: job.id }, { status: JobStatus.Closed });
      expect(
        (await submit(token, type, { jobId: job.id, answers: correctAnswers(questions) })).status
      ).toBe(400);
    });

    it("a recruiter can't submit candidate answers → 403", async () => {
      const { job, questions } = await servedApplicant(type);
      const { token: recruiterToken } = await createRecruiter();
      const res = await submit(recruiterToken, type, {
        jobId: job.id,
        answers: correctAnswers(questions),
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
  it.each([QuestionType.ProblemSolving, QuestionType.CultureFit] as const)(
    "two quick %s submissions store one score and one answer row",
    async (type) => {
      const { token, job, talent, application, questions } = await servedApplicant(type);
      const body = { jobId: job.id, answers: correctAnswers(questions) };

      const statuses = (await Promise.all([submit(token, type, body), submit(token, type, body)]))
        .map((r) => r.status)
        .sort();

      expect(statuses).toEqual([200, 409]);
      const rows = await testDataSource
        .getRepository(Answer)
        .find({ where: { userId: talent.id, jobId: job.id, questionType: type } });
      expect(rows).toHaveLength(1);
      expect((await reloadApplication(application.id))[SETTINGS[type].score]).toBe(100);
    }
  );

  it("overlapping problem-solving and culture-fit submissions keep both scores", async () => {
    const { user: recruiter } = await createRecruiter();
    const config = await createAIConfig(recruiter, {
      problemSolvingAssessment: true,
      noOfProblemSolvingQuestions: 2,
      cultureFitAssessment: true,
      noOfCultureFitQuestions: 2,
    });
    const job = await createJob(recruiter, await createRole(), { aiConfigId: config.id });
    const ps = [
      await choiceQuestion(QuestionType.ProblemSolving, job.id, 0),
      await choiceQuestion(QuestionType.ProblemSolving, job.id, 1),
    ];
    const cf = [
      await choiceQuestion(QuestionType.CultureFit, job.id, 0),
      await choiceQuestion(QuestionType.CultureFit, job.id, 1),
    ];
    const { token, user: talent } = await createCompleteTalent();
    const application = await createApplication(talent, job, {
      problemSolvingQuestions: ps.map((q) => q.id),
      cultureFitQuestions: cf.map((q) => q.id),
    } as Partial<Application>);

    const [a, b] = await Promise.all([
      submit(token, QuestionType.ProblemSolving, { jobId: job.id, answers: correctAnswers(ps) }),
      submit(token, QuestionType.CultureFit, { jobId: job.id, answers: answersWithWrong(cf, 1) }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    const saved = await reloadApplication(application.id);
    expect(saved.problemSolvingScore).toBe(100);
    expect(saved.cultureFitScore).toBe(50);
  });

  it("doesn't touch the personality result saved on the same application", async () => {
    const { job, token, application, questions } = await servedApplicant(
      QuestionType.ProblemSolving
    );
    await testDataSource.getRepository(Application).update(application.id, {
      mbtiType: "INTJ",
      personalityFitScore: 70,
      personalityFitReason: "Fits.",
    });

    const res = await submit(token, QuestionType.ProblemSolving, {
      jobId: job.id,
      answers: correctAnswers(questions),
    });

    expect(res.status).toBe(200);
    const saved = await reloadApplication(application.id);
    expect(saved.mbtiType).toBe("INTJ");
    expect(saved.personalityFitScore).toBe(70);
    expect(saved.personalityFitReason).toBe("Fits.");
  });

  it("after a recruiter deletes one of their questions, the candidate reloads and submits", async () => {
    const { token, job, application, questions } = await servedApplicant(
      QuestionType.ProblemSolving
    );
    await testDataSource.getRepository(Question).delete({ id: questions[0]!.id });

    const stale = await submit(token, QuestionType.ProblemSolving, {
      jobId: job.id,
      answers: correctAnswers(questions.slice(1)),
    });
    expect(stale.status).toBe(400);
    expect(errorMessage(stale)).toMatch(/reload/i);

    const reload = await request(app)
      .get("/v1/questions/candidate/problem-solving")
      .query({ jobId: job.id })
      .set("Authorization", `Bearer ${token}`);
    const served = apiData<{ questions: Array<{ id: string }> }>(reload).questions;
    expect(served.map((q) => q.id).sort()).toEqual(
      questions
        .slice(1)
        .map((q) => q.id)
        .sort()
    );

    const res = await submit(token, QuestionType.ProblemSolving, {
      jobId: job.id,
      answers: correctAnswers(questions.filter((q) => served.some((s) => s.id === q.id))),
    });

    expect(res.status).toBe(200);
    expect((await reloadApplication(application.id)).problemSolvingScore).toBe(100);
  });

  it("a jobId sent as a list → 400", async () => {
    const { token, job, questions } = await servedApplicant(QuestionType.ProblemSolving);
    const res = await submit(token, QuestionType.ProblemSolving, {
      jobId: [job.id],
      answers: correctAnswers(questions),
    });
    expect(res.status).toBe(400);
  });
});

describe("AddMultipleChoiceToQuestions migration", () => {
  it("adds two nullable columns and removes them on down", async () => {
    const queries: string[] = [];
    const runner = {
      query: (sql: string) => Promise.resolve(void queries.push(sql)),
    } as unknown as QueryRunner;
    await new AddMultipleChoiceToQuestions1789004300000().up(runner);
    expect(queries).toEqual([
      `ALTER TABLE "questions" ADD "options" jsonb`,
      `ALTER TABLE "questions" ADD "correctOption" integer`,
    ]);
    queries.length = 0;
    await new AddMultipleChoiceToQuestions1789004300000().down(runner);
    expect(queries).toEqual([
      `ALTER TABLE "questions" DROP COLUMN "correctOption"`,
      `ALTER TABLE "questions" DROP COLUMN "options"`,
    ]);
  });
});
