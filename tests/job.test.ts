import request from "supertest";
import { Types } from "mongoose";
import createApp from "../src/createApp";
import * as jobRepository from "../src/repository/v1/job";
import * as roleRepository from "../src/repository/v1/role";
import * as aiConfigRepository from "../src/repository/v1/AIconfig";
import * as pgRepository from "../src/repository/v1/pg";
import * as userRepository from "../src/repository/v1/user";
import * as openaiService from "../src/services/v1/openai";
import { signToken } from "../src/helpers/utils";
import { Roles } from "../src/typings/customs";
import { WorkMode } from "../src/typings/job";

jest.mock("../src/repository/v1/job");
jest.mock("../src/repository/v1/role");
jest.mock("../src/repository/v1/AIconfig");
jest.mock("../src/repository/v1/pg");
jest.mock("../src/repository/v1/user");
jest.mock("../src/services/v1/openai");

const mockedJobRepository = jest.mocked(jobRepository);
const mockedRoleRepository = jest.mocked(roleRepository);
const mockedUserRepository = jest.mocked(userRepository);
const mockedPgRepository = jest.mocked(pgRepository);
const mockedOpenai = jest.mocked(openaiService);

const app = createApp();

const RECRUITER_ID = "507f1f77bcf86cd799439011";
const ROLE_ID = "507f1f77bcf86cd799439022";
const JOB_ID = "507f1f77bcf86cd799439033";

const buildRecruiter = (overrides: Record<string, any> = {}): any => ({
  _id: RECRUITER_ID,
  email: "recruiter@example.com",
  firstName: "Ada",
  lastName: "Recruiter",
  userRole: Roles.Recruiter,
  active: true,
  emailVerified: true,
  tokenVersion: 0,
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

const buildRole = (overrides: Record<string, any> = {}): any => ({
  _id: new Types.ObjectId(ROLE_ID),
  id: ROLE_ID,
  name: "software engineer",
  ...overrides,
});

const buildJob = (overrides: Record<string, any> = {}): any => ({
  _id: new Types.ObjectId(JOB_ID),
  role: new Types.ObjectId(ROLE_ID),
  postedBy: new Types.ObjectId(RECRUITER_ID),
  jobBrief: "We are looking for a senior software engineer.",
  experienceLevel: "4-6 years",
  minSalary: 60000,
  maxSalary: 90000,
  workMode: [WorkMode.Remote, WorkMode.Hybrid],
  location: { state: "lagos", country: "nigeria" },
  status: "active",
  noOfApplicants: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const recruiterToken = () => {
  const recruiter = buildRecruiter();
  return signToken({ _id: recruiter._id, email: recruiter.email, tokenVersion: 0 });
};

const VALID_PAYLOAD = {
  role: "Software Engineer",
  jobBrief: "We are looking for a senior software engineer.",
  experienceLevel: "4-6 years",
  minSalary: 60000,
  maxSalary: 90000,
  workMode: [WorkMode.Remote, WorkMode.Hybrid],
  location: { state: "Lagos", country: "Nigeria" },
};

describe("Job posting", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Auth middleware: return recruiter by default
    mockedUserRepository.findUserAuthById.mockResolvedValue(buildRecruiter() as any);

    // Role: not found by name → create new
    mockedRoleRepository.findRoleByMatch.mockResolvedValue(null);
    mockedRoleRepository.createRole.mockResolvedValue(buildRole() as any);

    // Embedding: succeed
    mockedOpenai.createEmbedding.mockResolvedValue([{ embedding: Array(512).fill(0.1) }] as any);

    // Job create: succeed
    mockedJobRepository.createJob.mockResolvedValue(buildJob() as any);

    // PG embedding save: succeed
    mockedPgRepository.saveJobEmbedding.mockResolvedValue(true as any);
  });

  describe("POST /v1/jobs/", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await request(app).post("/v1/jobs/").send(VALID_PAYLOAD);
      expect(res.status).toBe(401);
    });

    it("rejects requests from talent users", async () => {
      mockedUserRepository.findUserAuthById.mockResolvedValue(
        buildRecruiter({ userRole: Roles.Talent }) as any
      );
      const token = signToken({ _id: RECRUITER_ID as any, email: "r@r.com", tokenVersion: 0 });

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send(VALID_PAYLOAD);

      expect(res.status).toBe(403);
    });

    it("creates a job with a single workMode", async () => {
      const token = recruiterToken();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...VALID_PAYLOAD, workMode: [WorkMode.Remote] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(true);
      expect(res.body.message).toBe("Job posted successfully");
    });

    it("creates a job with multiple workModes", async () => {
      const token = recruiterToken();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send(VALID_PAYLOAD);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(true);
      expect(mockedJobRepository.createJob).toHaveBeenCalledWith(
        expect.objectContaining({ workMode: [WorkMode.Remote, WorkMode.Hybrid] })
      );
    });

    it("rejects an invalid workMode value", async () => {
      const token = recruiterToken();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...VALID_PAYLOAD, workMode: ["flying"] });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe(false);
    });

    it("rejects a missing workMode field", async () => {
      const token = recruiterToken();
      const { workMode: _omit, ...withoutWorkMode } = VALID_PAYLOAD;

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send(withoutWorkMode);

      expect(res.status).toBe(400);
      expect(res.body.status).toBe(false);
    });

    it("rejects an empty workMode array", async () => {
      const token = recruiterToken();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...VALID_PAYLOAD, workMode: [] });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe(false);
    });

    it("rejects a workMode string instead of array", async () => {
      const token = recruiterToken();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...VALID_PAYLOAD, workMode: "remote" });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe(false);
    });

    it("rejects missing jobBrief", async () => {
      const token = recruiterToken();
      const { jobBrief: _omit, ...payload } = VALID_PAYLOAD;

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send(payload);

      expect(res.status).toBe(400);
    });

    it("rejects when minSalary >= maxSalary", async () => {
      const token = recruiterToken();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...VALID_PAYLOAD, minSalary: 90000, maxSalary: 90000 });

      expect(res.status).toBe(400);
    });

    it("rejects an invalid experienceLevel value", async () => {
      const token = recruiterToken();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...VALID_PAYLOAD, experienceLevel: "a million years" });

      expect(res.status).toBe(400);
    });

    it("auto-creates a role when given a name string not in the database", async () => {
      const token = recruiterToken();

      await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...VALID_PAYLOAD, role: "Brand New Role" });

      expect(mockedRoleRepository.createRole).toHaveBeenCalledWith({ name: "Brand New Role" });
    });

    it("reuses an existing role when the name matches", async () => {
      mockedRoleRepository.findRoleByMatch.mockResolvedValue(buildRole() as any);
      const token = recruiterToken();

      await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send(VALID_PAYLOAD);

      expect(mockedRoleRepository.createRole).not.toHaveBeenCalled();
    });

    it("resolves a role given a valid ObjectId", async () => {
      mockedRoleRepository.findRoleById.mockResolvedValue(buildRole() as any);
      const token = recruiterToken();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...VALID_PAYLOAD, role: ROLE_ID });

      expect(res.status).toBe(200);
      expect(mockedRoleRepository.findRoleById).toHaveBeenCalledWith(ROLE_ID);
    });

    it("returns 404 when a role ObjectId does not exist", async () => {
      mockedRoleRepository.findRoleById.mockResolvedValue(null);
      const token = recruiterToken();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...VALID_PAYLOAD, role: ROLE_ID });

      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Role does not exist");
    });

    it("returns 400 when the embedding service fails", async () => {
      mockedOpenai.createEmbedding.mockResolvedValue([] as any);
      const token = recruiterToken();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send(VALID_PAYLOAD);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("embedding");
    });

    it("returns 500 when the vector DB save fails", async () => {
      mockedPgRepository.saveJobEmbedding.mockResolvedValue(null as any);
      const token = recruiterToken();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send(VALID_PAYLOAD);

      expect(res.status).toBe(500);
    });

    it("accepts an optional currency field", async () => {
      const token = recruiterToken();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...VALID_PAYLOAD, currency: "NGN" });

      expect(res.status).toBe(200);
      expect(mockedJobRepository.createJob).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "NGN" })
      );
    });

    it("sets postedBy to the authenticated recruiter's id", async () => {
      const token = recruiterToken();

      await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send(VALID_PAYLOAD);

      expect(mockedJobRepository.createJob).toHaveBeenCalledWith(
        expect.objectContaining({ postedBy: RECRUITER_ID })
      );
    });
  });

  describe("PATCH /v1/jobs/:_id (workMode update)", () => {
    beforeEach(() => {
      mockedJobRepository.findJobById.mockResolvedValue(
        buildJob({ postedBy: { _id: { toString: () => RECRUITER_ID } } }) as any
      );
      mockedJobRepository.findJobByIdAndUpdate.mockResolvedValue(buildJob() as any);
    });

    it("accepts updating workMode to a new array", async () => {
      const token = recruiterToken();

      const res = await request(app)
        .patch(`/v1/jobs/${JOB_ID}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ workMode: [WorkMode.OnSite] });

      expect(res.status).toBe(200);
    });

    it("rejects updating workMode to an invalid value", async () => {
      const token = recruiterToken();

      const res = await request(app)
        .patch(`/v1/jobs/${JOB_ID}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ workMode: ["invalid-mode"] });

      expect(res.status).toBe(400);
    });

    it("rejects an empty workMode array on update", async () => {
      const token = recruiterToken();

      const res = await request(app)
        .patch(`/v1/jobs/${JOB_ID}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ workMode: [] });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/jobs/ (workMode filter)", () => {
    beforeEach(() => {
      mockedJobRepository.findAllJobs.mockResolvedValue([buildJob()] as any);
    });

    it("returns jobs without any filter", async () => {
      const res = await request(app).get("/v1/jobs/");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(true);
    });

    it("accepts a single workMode query filter", async () => {
      const res = await request(app).get("/v1/jobs/?workMode=remote");
      expect(res.status).toBe(200);
      expect(mockedJobRepository.findAllJobs).toHaveBeenCalledWith(
        expect.objectContaining({ workMode: { $in: ["remote"] } }),
        expect.anything()
      );
    });

    it("accepts multiple comma-separated workMode filters", async () => {
      const res = await request(app).get("/v1/jobs/?workMode=remote,hybrid");
      expect(res.status).toBe(200);
      expect(mockedJobRepository.findAllJobs).toHaveBeenCalledWith(
        expect.objectContaining({ workMode: { $in: ["remote", "hybrid"] } }),
        expect.anything()
      );
    });

    it("returns 400 for an invalid workMode filter value", async () => {
      const res = await request(app).get("/v1/jobs/?workMode=flying");
      expect(res.status).toBe(400);
      expect(res.body.status).toBe(false);
    });
  });
});
