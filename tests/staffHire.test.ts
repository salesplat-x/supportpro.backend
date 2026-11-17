import request from "supertest";
import { createApp } from "../src/app.js";
import { StaffMember } from "../src/entities/StaffMember.js";
import { ApplicationStatus } from "../src/types/enums.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createApplication, createJob, createRole, createTalent } from "./helpers/fixtures.js";
import { postStaff, staffPath } from "./helpers/staff.js";

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

const shortlistedApplicant = async (status = ApplicationStatus.Shortlisted) => {
  const { owner, org } = await setupCompany();
  const role = await createRole("Data Analyst");
  const job = await createJob(owner.user, role, { organizationId: org.id });
  const { user: talent } = await createTalent({
    firstName: "Kelechi",
    lastName: "Okoro",
    email: `kelechi_${Date.now()}@example.com`,
  });
  const application = await createApplication(talent, job, { status });
  return { owner, org, talent, application };
};

const hire = (
  token: string,
  orgId: string,
  applicationId: string,
  overrides: Record<string, unknown> = {}
) => postStaff(app, token, orgId, { applicationId, ...overrides });

const staffCount = () => testDataSource.getRepository(StaffMember).count();

describe("adding a shortlisted applicant as an employee", () => {
  it("uses the applicant's own name and email and marks them hired through AuxHR", async () => {
    const { owner, org, talent, application } = await shortlistedApplicant();

    const res = await hire(owner.token, org.id, application.id).expect(201);

    const { staff } = apiData<{ staff: { id: string; hiredThroughAuxhr: boolean } }>(res);
    expect(staff.hiredThroughAuxhr).toBe(true);
    const stored = await testDataSource
      .getRepository(StaffMember)
      .findOneByOrFail({ id: staff.id });
    expect(stored).toMatchObject({
      fullName: "Kelechi Okoro",
      email: talent.email.toLowerCase(),
      sourceApplicationId: application.id,
      hiredThroughAuxhr: true,
    });
  });

  it("ignores a different name or email sent by the client", async () => {
    const { owner, org, talent, application } = await shortlistedApplicant();

    const res = await hire(owner.token, org.id, application.id, {
      fullName: "Someone Else",
      email: "someone.else@example.com",
    }).expect(201);

    const { staff } = apiData<{ staff: { id: string } }>(res);
    const stored = await testDataSource
      .getRepository(StaffMember)
      .findOneByOrFail({ id: staff.id });
    expect(stored.email).toBe(talent.email.toLowerCase());
    expect(stored.fullName).toBe("Kelechi Okoro");
  });

  it.each([
    ApplicationStatus.Pending,
    ApplicationStatus.Rejected,
    ApplicationStatus.AwaitingDecision,
  ])("an application that is %s → 409 and nobody is added", async (status) => {
    const { owner, org, application } = await shortlistedApplicant(status);

    const res = await hire(owner.token, org.id, application.id);

    expect(res.status).toBe(409);
    expect(await staffCount()).toBe(0);
  });

  it("another company's application → 404", async () => {
    const { application } = await shortlistedApplicant();
    const { owner: other, org: otherOrg } = await setupCompany("Other Ltd");

    const res = await hire(other.token, otherOrg.id, application.id);

    expect(res.status).toBe(404);
    expect(await staffCount()).toBe(0);
  });

  it("an application id that doesn't exist → 404", async () => {
    const { owner, org } = await shortlistedApplicant();

    await hire(owner.token, org.id, "00000000-0000-4000-8000-000000000000").expect(404);
  });

  it("a recruiter without Can manage people → 403", async () => {
    const { org, application } = await shortlistedApplicant();
    const recruiter = await addMember(org, { canManagePeople: false });

    await hire(recruiter.token, org.id, application.id).expect(403);
    expect(await staffCount()).toBe(0);
  });

  it("two clicks at once add one person and the other gets 409", async () => {
    const { owner, org, application } = await shortlistedApplicant();

    const results = await Promise.all([
      hire(owner.token, org.id, application.id),
      hire(owner.token, org.id, application.id),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await staffCount()).toBe(1);
  });

  it("the same application can't be used again after the employment ends", async () => {
    const { owner, org, application } = await shortlistedApplicant();
    const first = await hire(owner.token, org.id, application.id).expect(201);
    const { staff } = apiData<{ staff: { id: string; startDate: string } }>(first);
    await request(app)
      .post(staffPath(org.id, `/${staff.id}/end`))
      .set(authHeader(owner.token))
      .send({ endDate: staff.startDate })
      .expect(200);

    const res = await hire(owner.token, org.id, application.id);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("This applicant is already on your staff");
  });

  it("counts people hired through AuxHR on the list", async () => {
    const { owner, org, application } = await shortlistedApplicant();
    await hire(owner.token, org.id, application.id).expect(201);
    await postStaff(app, owner.token, org.id).expect(201);

    const res = await request(app).get(staffPath(org.id)).set(authHeader(owner.token)).expect(200);

    const data = apiData<{ total: number; hiredThroughAuxhr: number }>(res);
    expect(data.total).toBe(2);
    expect(data.hiredThroughAuxhr).toBe(1);
  });

  it("someone added by hand is never marked hired through AuxHR", async () => {
    const { owner, org } = await setupCompany();

    const res = await postStaff(app, owner.token, org.id, { hiredThroughAuxhr: true }).expect(201);

    expect(apiData<{ staff: { hiredThroughAuxhr: boolean } }>(res).staff.hiredThroughAuxhr).toBe(
      false
    );
  });

  it("rejects an application id that isn't a uuid → 400", async () => {
    const { owner, org } = await setupCompany();

    await postStaff(app, owner.token, org.id, { applicationId: "nope" }).expect(400);
  });
});
