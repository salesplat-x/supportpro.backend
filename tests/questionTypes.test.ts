import { QueryRunner } from "typeorm";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { createRecruiter, createRole, createJob } from "./helpers/fixtures.js";
import { Question } from "../src/entities/Question.js";
import { Answer } from "../src/entities/Answer.js";
import { QuestionType } from "../src/types/enums.js";
import { AddProblemSolvingCultureFitQuestionTypes1789000700000 } from "../src/migrations/1789000700000-AddProblemSolvingCultureFitQuestionTypes.js";

const PROBLEM_SOLVING = "problem_solving";
const CULTURE_FIT = "culture_fit";

beforeAll(async () => {
  await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await clearAllTables();
});

describe("QuestionType enum", () => {
  it("includes the problem-solving and culture-fit types", () => {
    const values = Object.values(QuestionType) as string[];
    expect(values).toContain(PROBLEM_SOLVING);
    expect(values).toContain(CULTURE_FIT);
  });

  it("keeps the existing types unchanged", () => {
    const values = Object.values(QuestionType) as string[];
    expect(values).toEqual(expect.arrayContaining(["prescreening", "personality", "personalized"]));
  });
});

describe("questions and answers tables", () => {
  it.each([PROBLEM_SOLVING, CULTURE_FIT])("stores a %s question for a job", async (type) => {
    const { user: recruiter } = await createRecruiter();
    const job = await createJob(recruiter, await createRole());
    const repo = testDataSource.getRepository(Question);

    const saved = await repo.save(
      repo.create({
        type: type as QuestionType,
        question: "A train leaves at 9:00 travelling 60 km/h. When does it cover 150 km?",
        jobId: job.id,
        category: "numerical",
        criteria: "Sets up distance = speed x time and answers 11:30.",
      })
    );

    const found = await repo.findOneByOrFail({ id: saved.id });
    expect(found.type).toBe(type);
    expect(found.category).toBe("numerical");
  });

  it.each([PROBLEM_SOLVING, CULTURE_FIT])("stores an answer set of type %s", async (type) => {
    const { user: recruiter } = await createRecruiter();
    const job = await createJob(recruiter, await createRole());
    const repo = testDataSource.getRepository(Answer);

    const saved = await repo.save(
      repo.create({ userId: recruiter.id, jobId: job.id, questionType: type as QuestionType })
    );
    expect((await repo.findOneByOrFail({ id: saved.id })).questionType).toBe(type);
  });
});

describe("AddProblemSolvingCultureFitQuestionTypes migration", () => {
  it("adds both values to the questions and answers enum types, idempotently", async () => {
    const Migration = AddProblemSolvingCultureFitQuestionTypes1789000700000;
    const queries: string[] = [];
    const runner = {
      query: jest.fn((sql: string) => {
        queries.push(sql);
        return Promise.resolve();
      }),
    } as unknown as QueryRunner;

    await new Migration().up(runner);

    for (const enumType of ["questions_type_enum", "answers_questiontype_enum"]) {
      for (const value of [PROBLEM_SOLVING, CULTURE_FIT]) {
        expect(queries).toContain(
          `ALTER TYPE "public"."${enumType}" ADD VALUE IF NOT EXISTS '${value}'`
        );
      }
    }
  });

  it("applies cleanly against a real database and is safe to run twice", async () => {
    const Migration = AddProblemSolvingCultureFitQuestionTypes1789000700000;
    const runner = testDataSource.createQueryRunner();
    try {
      await new Migration().up(runner);
      await new Migration().up(runner);
    } finally {
      await runner.release();
    }
    const rows = (await testDataSource.query(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'questions_type_enum'`
    )) as { label: string }[];
    expect(rows.map((r) => r.label)).toEqual(
      expect.arrayContaining([PROBLEM_SOLVING, CULTURE_FIT])
    );
  });
});
