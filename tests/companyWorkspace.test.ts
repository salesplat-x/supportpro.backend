/**
 * Company workspace isolation — switching companies must change jobs,
 * scouting, dashboard, and application lists to that company's data.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { OrganizationMember, User } from "../src/entities";
import {
  createRecruiter,
  createOrganization,
  createRole,
  createJob,
  createApplication,
  createTalent,
  createScoutJob,
} from "./helpers/fixtures.js";

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

describe("company-scoped recruiter workspace", () => {
  it("GET /v1/jobs/me lists only jobs for the active company, and switches with the company", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgA = await createOrganization(recruiter, { name: "A Co" });
    const orgB = await createOrganization(recruiter, { name: "B Co" });
    const role = await createRole();
    const jobA = await createJob(recruiter, role, { organizationId: orgA.id });
    const jobB = await createJob(recruiter, role, { organizationId: orgB.id });

    const onB = await request(app).get("/v1/jobs/me").set("Authorization", `Bearer ${token}`);
    expect(onB.status).toBe(200);
    const idsOnB = (onB.body.data.jobs as { id: string }[]).map((job) => job.id);
    expect(idsOnB).toContain(jobB.id);
    expect(idsOnB).not.toContain(jobA.id);

    const switched = await request(app)
      .patch(`/v1/organizations/${orgA.id}/switch`)
      .set("Authorization", `Bearer ${token}`);
    expect(switched.status).toBe(200);

    const onA = await request(app).get("/v1/jobs/me").set("Authorization", `Bearer ${token}`);
    expect(onA.status).toBe(200);
    const idsOnA = (onA.body.data.jobs as { id: string }[]).map((job) => job.id);
    expect(idsOnA).toContain(jobA.id);
    expect(idsOnA).not.toContain(jobB.id);
  });

  it("blocks mutating a job that belongs to a company the recruiter is not working as", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgA = await createOrganization(recruiter, { name: "A Co" });
    const orgB = await createOrganization(recruiter, { name: "B Co" });
    const role = await createRole();
    const jobA = await createJob(recruiter, role, { organizationId: orgA.id });

    expect(orgB.id).not.toBe(orgA.id);

    const res = await request(app)
      .patch(`/v1/jobs/${jobA.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ jobBrief: "Should not apply while working as B Co" });

    expect(res.status).toBe(403);
  });

  it("scopes dashboard and applications to the active company", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgA = await createOrganization(recruiter, { name: "A Co" });
    const orgB = await createOrganization(recruiter, { name: "B Co" });
    const role = await createRole();
    const jobA = await createJob(recruiter, role, { organizationId: orgA.id });
    const jobB = await createJob(recruiter, role, { organizationId: orgB.id });
    const { user: talent } = await createTalent();
    const appA = await createApplication(talent, jobA);
    const appB = await createApplication(talent, jobB);

    const dashboardB = await request(app)
      .get("/v1/recruiter/dashboard")
      .set("Authorization", `Bearer ${token}`);
    expect(dashboardB.status).toBe(200);
    expect(dashboardB.body.data.data.applicationsCount).toBe(1);
    expect(dashboardB.body.data.data.recentApplications).toHaveLength(1);
    expect(dashboardB.body.data.data.recentApplications[0].id).toBe(appB.id);

    const appsB = await request(app)
      .get("/v1/recruiter/applications")
      .set("Authorization", `Bearer ${token}`);
    expect(appsB.status).toBe(200);
    const appIdsB = (appsB.body.data.applications as { id: string }[]).map((app) => app.id);
    expect(appIdsB).toEqual([appB.id]);

    await request(app)
      .patch(`/v1/organizations/${orgA.id}/switch`)
      .set("Authorization", `Bearer ${token}`);

    const dashboardA = await request(app)
      .get("/v1/recruiter/dashboard")
      .set("Authorization", `Bearer ${token}`);
    expect(dashboardA.body.data.data.recentApplications[0].id).toBe(appA.id);

    const appsA = await request(app)
      .get("/v1/recruiter/applications")
      .set("Authorization", `Bearer ${token}`);
    const appIdsA = (appsA.body.data.applications as { id: string }[]).map((app) => app.id);
    expect(appIdsA).toEqual([appA.id]);
  });

  it("scopes scout jobs to the active company", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgA = await createOrganization(recruiter, { name: "A Co" });
    const orgB = await createOrganization(recruiter, { name: "B Co" });
    const scoutA = await createScoutJob(recruiter, undefined, { organizationId: orgA.id });
    const scoutB = await createScoutJob(recruiter, undefined, { organizationId: orgB.id });

    const onB = await request(app).get("/v1/scout/jobs").set("Authorization", `Bearer ${token}`);
    expect(onB.status).toBe(200);
    const idsOnB = (onB.body.data.scoutJobs as { id: string }[]).map((job) => job.id);
    expect(idsOnB).toContain(scoutB.id);
    expect(idsOnB).not.toContain(scoutA.id);

    await request(app)
      .patch(`/v1/organizations/${orgA.id}/switch`)
      .set("Authorization", `Bearer ${token}`);

    const onA = await request(app).get("/v1/scout/jobs").set("Authorization", `Bearer ${token}`);
    const idsOnA = (onA.body.data.scoutJobs as { id: string }[]).map((job) => job.id);
    expect(idsOnA).toContain(scoutA.id);
    expect(idsOnA).not.toContain(scoutB.id);
  });

  it("lets a teammate see the active company's jobs", async () => {
    const { user: owner } = await createRecruiter();
    const { user: teammate, token: teammateToken } = await createRecruiter();
    const org = await createOrganization(owner, { name: "Shared Co" });
    await testDataSource.getRepository(OrganizationMember).save(
      testDataSource.getRepository(OrganizationMember).create({
        userId: teammate.id,
        organizationId: org.id,
        workEmail: teammate.email,
        role: "member",
      })
    );
    await testDataSource.getRepository(User).update(teammate.id, {
      activeOrganizationId: org.id,
    });

    const role = await createRole();
    const job = await createJob(owner, role, { organizationId: org.id });

    const res = await request(app)
      .get("/v1/jobs/me")
      .set("Authorization", `Bearer ${teammateToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body.data.jobs as { id: string }[]).map((item) => item.id);
    expect(ids).toEqual([job.id]);
  });

  it("GET /v1/jobs/me is empty when the recruiter has no active company", async () => {
    const { token } = await createRecruiter();
    const res = await request(app).get("/v1/jobs/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.jobs).toEqual([]);
  });
});
