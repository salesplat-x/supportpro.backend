/**
 * Problem-solving and culture-fit question generation (plan Day 3).
 * End-of-day proof: "Questions are created for a test job."
 * The AI is mocked; only company members may generate or see these questions.
 */

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
  createAdmin,
  createCompleteTalent,
  createRole,
  createJob,
  createOrganization,
  createQuestion,
} from "./helpers/fixtures.js";
import { Question } from "../src/entities/Question.js";
import { User } from "../src/entities/User.js";
import { Organization } from "../src/entities/Organization.js";
import { QuestionType } from "../src/types/enums.js";
import * as AI from "../src/utils/integrations/openai.js";
import { apiData } from "./helpers/http.js";

type GeneratedData = { questions: Question[]; basedOnCompanyValues?: boolean };
const dataOf = (res: Parameters<typeof apiData>[0]) => apiData<GeneratedData>(res);

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  generateProblemSolvingQuestions: jest.fn(),
  generateCultureFitQuestions: jest.fn(),
}));

const mockProblemSolving = AI.generateProblemSolvingQuestions as jest.Mock;
const mockCultureFit = AI.generateCultureFitQuestions as jest.Mock;

const aiReply = (questions: unknown) => ({
  message: { content: JSON.stringify({ questions }) },
});
const reasoningQuestions = (n: number, start = 1) =>
  Array.from({ length: n }, (_, i) => ({
    question: `Reasoning scenario number ${start + i}: how would you work it out?`,
    category: "logical",
    criteria: "States assumptions and checks the result.",
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

/** A recruiter, their company, and a test job posted under it. */
async function companyWithJob(orgOverrides: Partial<Organization> = {}) {
  const { user: recruiter, token } = await createRecruiter();
  const org = await createOrganization(recruiter, { name: "Acme Ltd", ...orgOverrides });
  const job = await createJob(recruiter, await createRole(), {
    organizationId: org.id,
    jobBrief: "Customer support lead for a fast-growing fintech.",
  });
  return { recruiter, token, org, job };
}

const storedQuestions = (jobId: string, type: QuestionType) =>
  testDataSource.getRepository(Question).find({ where: { jobId, type } });

const postProblemSolving = (token: string, body: Record<string, unknown>) =>
  request(app)
    .post("/v1/questions/problem-solving")
    .set("Authorization", `Bearer ${token}`)
    .send(body);

const postCultureFit = (token: string, body: Record<string, unknown>) =>
  request(app).post("/v1/questions/culture-fit").set("Authorization", `Bearer ${token}`).send(body);

// ---------------------------------------------------------------------------
// POST /v1/questions/problem-solving
// ---------------------------------------------------------------------------

describe("POST /v1/questions/problem-solving", () => {
  it("Day 3 proof: creates problem-solving questions for a test job → 200", async () => {
    const { token, job } = await companyWithJob();
    mockProblemSolving.mockResolvedValueOnce(
      aiReply([
        {
          question: "You have three tasks due today and time for two. How do you decide?",
          category: "prioritisation",
          criteria: "Weighs impact, deadlines and who is affected.",
        },
        {
          question:
            "A shop sells 120 items a day and sales grow 10% a week. Roughly how many in 3 weeks?",
          category: "numerical",
          criteria: "Compounds the growth rather than adding 30%.",
        },
        {
          question: "Sales doubled but profit fell. What would you check first, and why?",
          category: "analytical",
          criteria: "Looks at costs, discounts and product mix.",
        },
      ])
    );

    const res = await postProblemSolving(token, { jobId: job.id, count: 3 });

    expect(res.status).toBe(200);
    expect(dataOf(res).questions).toHaveLength(3);
    const stored = await storedQuestions(job.id, QuestionType.ProblemSolving);
    expect(stored).toHaveLength(3);
    expect(stored.map((q) => q.category).sort()).toEqual([
      "analytical",
      "numerical",
      "prioritisation",
    ]);
    expect(stored.every((q) => q.criteria && q.jobId === job.id)).toBe(true);
  });

  it("asks the AI for the requested count and sends nothing about the job", async () => {
    const { token, job } = await companyWithJob();
    mockProblemSolving.mockResolvedValueOnce(aiReply(reasoningQuestions(2)));

    await postProblemSolving(token, { jobId: job.id, count: 2 });

    expect(mockProblemSolving).toHaveBeenCalledTimes(1);
    expect(mockProblemSolving).toHaveBeenCalledWith({ count: 2, avoid: [] });
  });

  it("defaults to 5 questions when count is omitted", async () => {
    const { token, job } = await companyWithJob();
    mockProblemSolving.mockResolvedValueOnce(aiReply(reasoningQuestions(5)));

    const res = await postProblemSolving(token, { jobId: job.id });

    expect(res.status).toBe(200);
    expect(mockProblemSolving).toHaveBeenCalledWith(expect.objectContaining({ count: 5 }));
    expect(await storedQuestions(job.id, QuestionType.ProblemSolving)).toHaveLength(5);
  });

  it("passes the job's existing questions so new ones don't repeat them", async () => {
    const { token, job } = await companyWithJob();
    await createQuestion(
      QuestionType.ProblemSolving,
      { jobId: job.id },
      { question: "How many piano tuners work in Lagos?" }
    );
    mockProblemSolving.mockResolvedValueOnce(aiReply(reasoningQuestions(1)));

    await postProblemSolving(token, { jobId: job.id, count: 1 });

    expect(mockProblemSolving).toHaveBeenCalledWith({
      count: 1,
      avoid: ["How many piano tuners work in Lagos?"],
    });
  });

  it("another member of the same company can generate → 200", async () => {
    const { org, job } = await companyWithJob();
    const { user: teammate, token: teammateToken } = await createRecruiter();
    await testDataSource.getRepository(User).update(teammate.id, { activeOrganizationId: org.id });
    mockProblemSolving.mockResolvedValueOnce(aiReply(reasoningQuestions(1)));

    const res = await postProblemSolving(teammateToken, { jobId: job.id, count: 1 });

    expect(res.status).toBe(200);
  });

  it("the poster of a job with no company (pre-tenancy) can generate → 200", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const job = await createJob(recruiter, await createRole());
    mockProblemSolving.mockResolvedValueOnce(aiReply(reasoningQuestions(1)));

    const res = await postProblemSolving(token, { jobId: job.id, count: 1 });

    expect(res.status).toBe(200);
  });

  it("a recruiter from another company cannot generate → 403, no AI call, nothing saved", async () => {
    const { job } = await companyWithJob();
    const { user: outsider, token: outsiderToken } = await createRecruiter();
    await createOrganization(outsider);

    const res = await postProblemSolving(outsiderToken, { jobId: job.id, count: 2 });

    expect(res.status).toBe(403);
    expect(mockProblemSolving).not.toHaveBeenCalled();
    expect(await storedQuestions(job.id, QuestionType.ProblemSolving)).toHaveLength(0);
  });

  it("a talent cannot generate → 403", async () => {
    const { job } = await companyWithJob();
    const { token: talentToken } = await createCompleteTalent();

    const res = await postProblemSolving(talentToken, { jobId: job.id });

    expect(res.status).toBe(403);
    expect(mockProblemSolving).not.toHaveBeenCalled();
  });

  it("unauthenticated → 401", async () => {
    const res = await request(app).post("/v1/questions/problem-solving").send({});
    expect(res.status).toBe(401);
  });

  it("unknown job → 404", async () => {
    const { token } = await companyWithJob();

    const res = await postProblemSolving(token, { jobId: "00000000-0000-4000-8000-000000000000" });

    expect(res.status).toBe(404);
  });

  it.each([
    ["a missing jobId", { jobId: undefined }],
    ["a jobId that is not an id", { jobId: "not-an-id" }],
    ["count 0", { count: 0 }],
    ["count 11", { count: 11 }],
    ["a count that is not a number", { count: "lots" }],
  ])("rejects %s → 400", async (_label, body) => {
    const { token, job } = await companyWithJob();

    const res = await postProblemSolving(token, { jobId: job.id, ...body });

    expect(res.status).toBe(400);
    expect(mockProblemSolving).not.toHaveBeenCalled();
  });

  it("retries once when the AI reply is malformed, then saves the good reply", async () => {
    const { token, job } = await companyWithJob();
    mockProblemSolving
      .mockResolvedValueOnce({ message: { content: "Sure! Here you go: 1. ..." } })
      .mockResolvedValueOnce(aiReply(reasoningQuestions(2)));

    const res = await postProblemSolving(token, { jobId: job.id, count: 2 });

    expect(res.status).toBe(200);
    expect(mockProblemSolving).toHaveBeenCalledTimes(2);
    expect(await storedQuestions(job.id, QuestionType.ProblemSolving)).toHaveLength(2);
  });

  it("asks again only for the missing questions when the AI returns too few", async () => {
    const { token, job } = await companyWithJob();
    mockProblemSolving
      .mockResolvedValueOnce(aiReply(reasoningQuestions(2)))
      .mockResolvedValueOnce(aiReply(reasoningQuestions(1, 3)));

    const res = await postProblemSolving(token, { jobId: job.id, count: 3 });

    expect(res.status).toBe(200);
    expect(mockProblemSolving).toHaveBeenLastCalledWith(expect.objectContaining({ count: 1 }));
    expect(await storedQuestions(job.id, QuestionType.ProblemSolving)).toHaveLength(3);
  });

  it("returns 502 with a clear message when the AI reply is unusable twice, saving nothing", async () => {
    const { token, job } = await companyWithJob();
    mockProblemSolving.mockResolvedValue({ message: { content: "{not json" } });

    const res = await postProblemSolving(token, { jobId: job.id, count: 2 });

    expect(res.status).toBe(502);
    expect((res.body as { error: { message: string } }).error.message).toMatch(
      /couldn't generate/i
    );
    expect(mockProblemSolving).toHaveBeenCalledTimes(2);
    expect(await storedQuestions(job.id, QuestionType.ProblemSolving)).toHaveLength(0);
  });

  it("returns 502 when the AI call itself fails, saving nothing", async () => {
    const { token, job } = await companyWithJob();
    mockProblemSolving.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const res = await postProblemSolving(token, { jobId: job.id, count: 2 });

    expect(res.status).toBe(502);
    expect(await storedQuestions(job.id, QuestionType.ProblemSolving)).toHaveLength(0);
  });

  it("refuses when the job already has the maximum of 30 problem-solving questions → 400", async () => {
    const { token, job } = await companyWithJob();
    const repo = testDataSource.getRepository(Question);
    await repo.save(
      Array.from({ length: 30 }, (_, i) =>
        repo.create({ type: QuestionType.ProblemSolving, jobId: job.id, question: `Existing ${i}` })
      )
    );

    const res = await postProblemSolving(token, { jobId: job.id, count: 1 });

    expect(res.status).toBe(400);
    expect(mockProblemSolving).not.toHaveBeenCalled();
  });

  it("only fills the pool up to 30 questions", async () => {
    const { token, job } = await companyWithJob();
    const repo = testDataSource.getRepository(Question);
    await repo.save(
      Array.from({ length: 28 }, (_, i) =>
        repo.create({ type: QuestionType.ProblemSolving, jobId: job.id, question: `Existing ${i}` })
      )
    );
    mockProblemSolving.mockResolvedValueOnce(aiReply(reasoningQuestions(2)));

    const res = await postProblemSolving(token, { jobId: job.id, count: 5 });

    expect(res.status).toBe(200);
    expect(mockProblemSolving).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }));
    expect(await storedQuestions(job.id, QuestionType.ProblemSolving)).toHaveLength(30);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/questions/culture-fit
// ---------------------------------------------------------------------------

describe("POST /v1/questions/culture-fit", () => {
  it("Day 3 proof: creates culture-fit questions from the company's values → 200", async () => {
    const { token, job } = await companyWithJob({
      companyValues: ["Ownership", "Customer obsession"],
    });
    mockCultureFit.mockResolvedValueOnce(
      aiReply([
        {
          question: "Tell me about a time you fixed a problem nobody had asked you to fix.",
          category: "ownership",
          criteria: "Acted without being asked and followed through.",
        },
        {
          question: "Describe a time you changed your plan because of what a customer told you.",
          category: "Customer obsession",
          criteria: "Started from the customer's need, not their own convenience.",
        },
      ])
    );

    const res = await postCultureFit(token, { jobId: job.id, count: 2 });

    expect(res.status).toBe(200);
    expect(dataOf(res).basedOnCompanyValues).toBe(true);
    const stored = await storedQuestions(job.id, QuestionType.CultureFit);
    expect(stored.map((q) => q.category).sort()).toEqual(["Customer obsession", "Ownership"]);
    expect(stored.every((q) => q.criteria)).toBe(true);
  });

  it("sends the company's values, name and job brief to the AI", async () => {
    const { token, job } = await companyWithJob({ companyValues: ["Ownership"] });
    mockCultureFit.mockResolvedValueOnce(
      aiReply([{ question: "Tell me about a time you owned a mistake.", category: "Ownership" }])
    );

    await postCultureFit(token, { jobId: job.id, count: 1 });

    expect(mockCultureFit).toHaveBeenCalledWith({
      count: 1,
      companyValues: ["Ownership"],
      companyName: "Acme Ltd",
      jobBrief: "Customer support lead for a fast-growing fintech.",
      avoid: [],
    });
  });

  it("still generates general working-style questions when the company has no values", async () => {
    const { token, job } = await companyWithJob();
    mockCultureFit.mockResolvedValueOnce(
      aiReply([
        {
          question: "Tell me about a time you disagreed with a teammate. What happened?",
          category: "collaboration",
        },
      ])
    );

    const res = await postCultureFit(token, { jobId: job.id, count: 1 });

    expect(res.status).toBe(200);
    expect(dataOf(res).basedOnCompanyValues).toBe(false);
    expect(mockCultureFit).toHaveBeenCalledWith(expect.objectContaining({ companyValues: [] }));
    const stored = await storedQuestions(job.id, QuestionType.CultureFit);
    expect(stored[0]!.category).toBe("collaboration");
  });

  it("a recruiter from another company cannot generate → 403", async () => {
    const { job } = await companyWithJob({ companyValues: ["Ownership"] });
    const { user: outsider, token: outsiderToken } = await createRecruiter();
    await createOrganization(outsider);

    const res = await postCultureFit(outsiderToken, { jobId: job.id });

    expect(res.status).toBe(403);
    expect(mockCultureFit).not.toHaveBeenCalled();
  });

  it("a talent cannot generate → 403", async () => {
    const { job } = await companyWithJob();
    const { token: talentToken } = await createCompleteTalent();

    const res = await postCultureFit(talentToken, { jobId: job.id });

    expect(res.status).toBe(403);
  });

  it("returns 502 when the AI reply is unusable twice, saving nothing", async () => {
    const { token, job } = await companyWithJob({ companyValues: ["Ownership"] });
    mockCultureFit.mockResolvedValue({ message: { content: null } });

    const res = await postCultureFit(token, { jobId: job.id, count: 2 });

    expect(res.status).toBe(502);
    expect(mockCultureFit).toHaveBeenCalledTimes(2);
    expect(await storedQuestions(job.id, QuestionType.CultureFit)).toHaveLength(0);
  });

  it("rejects count 11 → 400", async () => {
    const { token, job } = await companyWithJob();

    const res = await postCultureFit(token, { jobId: job.id, count: 11 });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/questions?questionType=problem_solving|culture_fit&jobId=…
// ---------------------------------------------------------------------------

describe("GET /v1/questions — problem-solving and culture-fit", () => {
  async function jobWithBothKinds() {
    const setup = await companyWithJob();
    await createQuestion(
      QuestionType.ProblemSolving,
      { jobId: setup.job.id },
      { question: "Reasoning question?", category: "logical", criteria: "Explains each step." }
    );
    await createQuestion(
      QuestionType.CultureFit,
      { jobId: setup.job.id },
      { question: "Culture question?", category: "Ownership", criteria: "Owns the outcome." }
    );
    return setup;
  }

  it.each([
    [QuestionType.ProblemSolving, "Reasoning question?"],
    [QuestionType.CultureFit, "Culture question?"],
  ])("a company member sees the job's %s questions with criteria → 200", async (type, text) => {
    const { token, job } = await jobWithBothKinds();

    const res = await request(app)
      .get(`/v1/questions?questionType=${type}&jobId=${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(dataOf(res).questions).toHaveLength(1);
    expect(dataOf(res).questions[0]!.question).toBe(text);
    expect(dataOf(res).questions[0]!.criteria).toBeTruthy();
  });

  it("a recruiter from another company cannot see them → 403", async () => {
    const { job } = await jobWithBothKinds();
    const { user: outsider, token: outsiderToken } = await createRecruiter();
    await createOrganization(outsider);

    const res = await request(app)
      .get(`/v1/questions?questionType=problem_solving&jobId=${job.id}`)
      .set("Authorization", `Bearer ${outsiderToken}`);

    expect(res.status).toBe(403);
  });

  it("a talent cannot see them (or their scoring criteria) yet → 403", async () => {
    const { job } = await jobWithBothKinds();
    const { token: talentToken } = await createCompleteTalent(await createRole());

    const res = await request(app)
      .get(`/v1/questions?questionType=culture_fit&jobId=${job.id}`)
      .set("Authorization", `Bearer ${talentToken}`);

    expect(res.status).toBe(403);
  });

  it("requires a jobId → 400", async () => {
    const { token } = await jobWithBothKinds();

    const res = await request(app)
      .get("/v1/questions?questionType=problem_solving")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it("unknown job → 404", async () => {
    const { token } = await jobWithBothKinds();

    const res = await request(app)
      .get("/v1/questions?questionType=problem_solving&jobId=00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/questions/:_id — problem-solving and culture-fit stay company-only
// ---------------------------------------------------------------------------

describe("GET /v1/questions/:_id — problem-solving and culture-fit", () => {
  type SingleData = { question: Question };
  const singleOf = (res: Parameters<typeof apiData>[0]) => apiData<SingleData>(res);

  async function jobWithAssessmentQuestion(type: QuestionType) {
    const setup = await companyWithJob();
    const question = await createQuestion(
      type,
      { jobId: setup.job.id },
      { question: "Hidden question?", criteria: "Secret scoring criteria." }
    );
    return { ...setup, question };
  }

  it.each([QuestionType.ProblemSolving, QuestionType.CultureFit])(
    "anonymous callers cannot read a %s question → 404",
    async (type) => {
      const { question } = await jobWithAssessmentQuestion(type);

      const res = await request(app).get(`/v1/questions/${question.id}`);

      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("Secret scoring criteria.");
    }
  );

  it("a talent cannot read one → 404", async () => {
    const { question } = await jobWithAssessmentQuestion(QuestionType.ProblemSolving);
    const { token } = await createCompleteTalent(await createRole());

    const res = await request(app)
      .get(`/v1/questions/${question.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("a recruiter from another company cannot read one → 404", async () => {
    const { question } = await jobWithAssessmentQuestion(QuestionType.CultureFit);
    const { user: outsider, token } = await createRecruiter();
    await createOrganization(outsider);

    const res = await request(app)
      .get(`/v1/questions/${question.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("a member of the job's company reads it with criteria → 200", async () => {
    const { token, question } = await jobWithAssessmentQuestion(QuestionType.ProblemSolving);

    const res = await request(app)
      .get(`/v1/questions/${question.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(singleOf(res).question.criteria).toBe("Secret scoring criteria.");
  });

  it("an admin reads it → 200", async () => {
    const { question } = await jobWithAssessmentQuestion(QuestionType.CultureFit);
    const { token } = await createAdmin();

    const res = await request(app)
      .get(`/v1/questions/${question.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("other question types are still readable without signing in → 200", async () => {
    const role = await createRole();
    const question = await createQuestion(QuestionType.Prescreening, { roleId: role.id });

    const res = await request(app).get(`/v1/questions/${question.id}`);

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Query strings that arrive as arrays or objects
// ---------------------------------------------------------------------------

describe("GET /v1/questions — non-text query values", () => {
  it.each([
    ["questionType as a list", (jobId: string) => `questionType[]=problem_solving&jobId=${jobId}`],
    [
      "questionType repeated",
      (jobId: string) => `questionType=problem_solving&questionType=culture_fit&jobId=${jobId}`,
    ],
    ["jobId as a list", (jobId: string) => `questionType=problem_solving&jobId[]=${jobId}`],
    ["jobId as an object", (jobId: string) => `questionType=problem_solving&jobId[id]=${jobId}`],
  ])("rejects %s → 400 without leaking criteria", async (_label, query) => {
    const { job } = await companyWithJob();
    await createQuestion(
      QuestionType.ProblemSolving,
      { jobId: job.id },
      { question: "Hidden question?", criteria: "Secret scoring criteria." }
    );
    const { token } = await createCompleteTalent(await createRole());

    const res = await request(app)
      .get(`/v1/questions?${query(job.id)}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("Secret scoring criteria.");
  });

  it("rejects a generate request whose count is a list → 400", async () => {
    const { token, job } = await companyWithJob();

    const res = await postProblemSolving(token, { jobId: job.id, count: [5, 6] });

    expect(res.status).toBe(400);
    expect(mockProblemSolving).not.toHaveBeenCalled();
  });

  it("rejects a generate request whose jobId is a list → 400", async () => {
    const { token, job } = await companyWithJob();

    const res = await postProblemSolving(token, { jobId: [job.id] });

    expect(res.status).toBe(400);
    expect(mockProblemSolving).not.toHaveBeenCalled();
  });
});
