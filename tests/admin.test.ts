import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { Application } from "../src/entities/Application.js";
import { Job } from "../src/entities/Job.js";
import { Message } from "../src/entities/Message.js";
import { TalentEmbedding } from "../src/entities/TalentEmbedding.js";
import { User } from "../src/entities/User.js";
import { Answer } from "../src/entities/Answer.js";
import { Question } from "../src/entities/Question.js";
import { QuestionType } from "../src/types/enums.js";
import {
  createAdmin,
  createApplication,
  createConversationWithMessage,
  createJob,
  createRecruiter,
  createRole,
  createTalent,
} from "./helpers/fixtures.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
}));

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
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
});

describe("Admin talents & jobs", () => {
  it("lists talents for admin and rejects recruiters", async () => {
    const { token: adminToken } = await createAdmin();
    const { token: recruiterToken } = await createRecruiter();
    await createTalent({ firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" });

    const denied = await request(app)
      .get("/v1/admin/talents")
      .set("Authorization", `Bearer ${recruiterToken}`);
    expect(denied.status).toBe(403);

    const res = await request(app)
      .get("/v1/admin/talents")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.users[0].firstName).toBe("Ada");
  });

  it("permanently deletes a talent and related records", async () => {
    const { token: adminToken } = await createAdmin();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent({
      firstName: "Grace",
      lastName: "Hopper",
      cvFileName: "grace.pdf",
      cvText: "Naval officer and computer scientist",
      cvUploadedAt: new Date(),
    });
    const application = await createApplication(talent, job);

    await testDataSource.getRepository(TalentEmbedding).save(
      testDataSource.getRepository(TalentEmbedding).create({
        userId: talent.id,
        cvText: "chunk",
        cvEmbedding: "[0.1,0.2]",
        generatedAt: new Date(),
      })
    );

    const { message } = await createConversationWithMessage(talent, recruiter);
    await testDataSource
      .getRepository(Message)
      .update({ id: message.id }, { applicationId: application.id });

    const res = await request(app)
      .delete(`/v1/admin/talents/${talent.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(
      await testDataSource.getRepository(User).findOne({ where: { id: talent.id } })
    ).toBeNull();
    expect(
      await testDataSource.getRepository(Application).findOne({ where: { id: application.id } })
    ).toBeNull();
    expect(
      await testDataSource.getRepository(TalentEmbedding).count({ where: { userId: talent.id } })
    ).toBe(0);
    expect(
      await testDataSource.getRepository(Message).findOne({ where: { id: message.id } })
    ).toBeNull();
  });

  it("lists jobs and permanently deletes a job with dependents", async () => {
    const { token: adminToken } = await createAdmin();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole("backend-engineer");
    const job = await createJob(recruiter, role, { jobBrief: "Build APIs" });
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);

    const question = await testDataSource.getRepository(Question).save(
      testDataSource.getRepository(Question).create({
        jobId: job.id,
        roleId: role.id,
        question: "Describe a system you designed",
        type: QuestionType.Personalized,
      })
    );
    await testDataSource.getRepository(Answer).save(
      testDataSource.getRepository(Answer).create({
        userId: talent.id,
        jobId: job.id,
        roleId: role.id,
        questionType: QuestionType.Personalized,
        responses: [{ questionId: question.id, answer: "I designed a payments ledger." }],
      })
    );

    const list = await request(app)
      .get("/v1/admin/jobs")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.total).toBe(1);

    const res = await request(app)
      .delete(`/v1/admin/jobs/${job.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    expect(await testDataSource.getRepository(Job).findOne({ where: { id: job.id } })).toBeNull();
    expect(
      await testDataSource.getRepository(Application).findOne({ where: { id: application.id } })
    ).toBeNull();
    expect(
      await testDataSource.getRepository(Question).findOne({ where: { id: question.id } })
    ).toBeNull();
    expect(await testDataSource.getRepository(Answer).count({ where: { jobId: job.id } })).toBe(0);
  });

  it("lists recruiters for admin and rejects talents", async () => {
    const { token: adminToken } = await createAdmin();
    const { token: talentToken } = await createTalent();
    await createRecruiter({
      firstName: "Sam",
      lastName: "Hiring",
      email: "sam.hiring@example.com",
    });

    const denied = await request(app)
      .get("/v1/admin/recruiters")
      .set("Authorization", `Bearer ${talentToken}`);
    expect(denied.status).toBe(403);

    const res = await request(app)
      .get("/v1/admin/recruiters")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.users[0].firstName).toBe("Sam");
  });

  it("permanently deletes a recruiter and related records", async () => {
    const { token: adminToken } = await createAdmin();
    const { user: recruiter } = await createRecruiter({
      firstName: "Pat",
      lastName: "Recruiter",
      email: "pat.recruiter@example.com",
    });
    const role = await createRole("frontend-engineer");
    const job = await createJob(recruiter, role, { jobBrief: "Ship UI" });
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);
    const { message } = await createConversationWithMessage(talent, recruiter);
    await testDataSource
      .getRepository(Message)
      .update({ id: message.id }, { applicationId: application.id });

    const res = await request(app)
      .delete(`/v1/admin/recruiters/${recruiter.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(
      await testDataSource.getRepository(User).findOne({ where: { id: recruiter.id } })
    ).toBeNull();
    expect(await testDataSource.getRepository(Job).findOne({ where: { id: job.id } })).toBeNull();
    expect(
      await testDataSource.getRepository(Application).findOne({ where: { id: application.id } })
    ).toBeNull();
    expect(
      await testDataSource.getRepository(Message).findOne({ where: { id: message.id } })
    ).toBeNull();
    // Talent account must remain
    expect(
      await testDataSource.getRepository(User).findOne({ where: { id: talent.id } })
    ).not.toBeNull();
  });

  it("rejects deleting a talent via the recruiters endpoint", async () => {
    const { token: adminToken } = await createAdmin();
    const { user: talent } = await createTalent();

    const res = await request(app)
      .delete(`/v1/admin/recruiters/${talent.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(
      await testDataSource.getRepository(User).findOne({ where: { id: talent.id } })
    ).not.toBeNull();
  });
});
