import request from "supertest";
import { createApp } from "../src/app.js";
import { Department } from "../src/entities/Department.js";
import { Notification, StaffAccessLog, StaffActivity } from "../src/entities";
import { StaffAccessResource } from "../src/entities/StaffAccessLog.js";
import { StaffActivityType } from "../src/entities/StaffActivity.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { apiData } from "./helpers/http.js";
import { endStaff, employee } from "./helpers/team.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  generateJobField: jest.fn(),
  suggestGoals: jest.fn(),
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

const departmentsPath = (orgId: string) => `/v1/organizations/${orgId}/departments`;

async function company() {
  const { owner, org } = await setupCompany();
  const head = await employee(app, owner.token, org.id, "Hana Head", {
    department: "Engineering",
  });
  const member = await employee(app, owner.token, org.id, "Mia Member", {
    department: "engineering",
  });
  const outsider = await employee(app, owner.token, org.id, "Olu Outsider", {
    department: "Sales",
  });
  const report = await employee(app, owner.token, org.id, "Remi Report", {
    department: "Sales",
    managerId: head.staff.id,
  });
  const engineering = await testDataSource
    .getRepository(Department)
    .findOneByOrFail({ organizationId: org.id, name: "Engineering" });
  const setHead = (token: string, staffId: string | null, departmentId = engineering.id) =>
    request(app)
      .put(`${departmentsPath(org.id)}/${departmentId}/head`)
      .set(authHeader(token))
      .send({ staffId });
  const teamPath = (staffId: string, suffix = "") =>
    `/v1/my-work/${head.staff.id}/team/${staffId}${suffix}`;
  return { owner, org, head, member, outsider, report, engineering, setHead, teamPath };
}

describe("department heads", () => {
  it("lists departments with their head and current headcount for any company member", async () => {
    const { owner, org, head, setHead } = await company();
    await setHead(owner.token, head.staff.id).expect(200);
    const recruiter = await addMember(org, { canManagePeople: false });

    const res = await request(app)
      .get(departmentsPath(org.id))
      .set(authHeader(recruiter.token))
      .expect(200);

    const departments = apiData<{
      departments: Array<{ name: string; head: { fullName: string } | null; staffCount: number }>;
    }>(res).departments;
    expect(
      departments.map(({ name, head: h, staffCount }) => [name, h?.fullName, staffCount])
    ).toEqual([
      ["Engineering", "Hana Head", 2],
      ["Sales", undefined, 2],
    ]);
  });

  it("only the company's creator can choose a head", async () => {
    const { org, head, setHead } = await company();
    const hr = await addMember(org, { canManagePeople: true });
    const { owner: outsider } = await setupCompany("Other Ltd");

    await setHead(hr.token, head.staff.id).expect(403);
    expect([403, 404]).toContain((await setHead(outsider.token, head.staff.id)).status);

    const department = await testDataSource
      .getRepository(Department)
      .findOneByOrFail({ organizationId: org.id, name: "Engineering" });
    expect(department.headStaffId).toBeNull();
  });

  it("records the change on both people and tells the new head", async () => {
    const { owner, head, member, setHead } = await company();

    await setHead(owner.token, head.staff.id).expect(200);
    await setHead(owner.token, member.staff.id).expect(200);

    const activities = await testDataSource.getRepository(StaffActivity).find({
      where: [
        { type: StaffActivityType.DepartmentHeadAssigned },
        { type: StaffActivityType.DepartmentHeadRemoved },
      ],
      order: { createdAt: "ASC" },
    });
    expect(activities.map((row) => [row.type, row.staffId])).toEqual([
      [StaffActivityType.DepartmentHeadAssigned, head.staff.id],
      [StaffActivityType.DepartmentHeadRemoved, head.staff.id],
      [StaffActivityType.DepartmentHeadAssigned, member.staff.id],
    ]);
    const notified = await testDataSource
      .getRepository(Notification)
      .findBy({ type: "department_head" });
    expect(notified.map((row) => row.userId).sort()).toEqual([head.user.id, member.user.id].sort());
  });

  it("refuses a head from another company or one whose employment has ended", async () => {
    const { owner, org, member, setHead } = await company();
    const other = await setupCompany("Other Ltd");
    const stranger = await employee(app, other.owner.token, other.org.id, "Sam Stranger");
    await endStaff(app, owner.token, org.id, member.staff.id, "2026-02-01");

    await setHead(owner.token, stranger.staff.id).expect(404);
    await setHead(owner.token, member.staff.id).expect(404);
  });

  it("lets a head manage everyone in their department, but not themselves or anyone else", async () => {
    const { owner, head, member, outsider, setHead, teamPath } = await company();
    await setHead(owner.token, head.staff.id).expect(200);

    await request(app).get(teamPath(member.staff.id)).set(authHeader(head.token)).expect(200);
    const goal = apiData<{ goal: { id: string } }>(
      await request(app)
        .post(teamPath(member.staff.id, "/goals"))
        .set(authHeader(head.token))
        .send({ title: "Ship the API", keyResults: ["Launch"], dueOn: "2099-01-01" })
        .expect(201)
    ).goal;
    await request(app)
      .post(teamPath(member.staff.id, `/goals/${goal.id}/approve`))
      .set(authHeader(head.token))
      .send({ version: 1 })
      .expect(200);

    await request(app).get(teamPath(outsider.staff.id)).set(authHeader(head.token)).expect(404);
    await request(app).get(teamPath(head.staff.id)).set(authHeader(head.token)).expect(404);
    await request(app).get(teamPath(member.staff.id)).set(authHeader(outsider.token)).expect(404);
  });

  it("shows a head their department's people's details, logs the read, and nothing private", async () => {
    const { owner, org, head, member, report, setHead, teamPath } = await company();
    await setHead(owner.token, head.staff.id).expect(200);

    const res = await request(app)
      .get(teamPath(member.staff.id, "/details"))
      .set(authHeader(head.token))
      .expect(200);

    const details = apiData<Record<string, unknown>>(res);
    expect(details).toMatchObject({
      staffId: member.staff.id,
      fullName: "Mia Member",
      department: "Engineering",
    });
    expect(Object.keys(details)).not.toContain("homeAddress");
    const logs = await testDataSource.getRepository(StaffAccessLog).findBy({
      organizationId: org.id,
      staffId: member.staff.id,
      resource: StaffAccessResource.StaffRecord,
    });
    expect(logs).toHaveLength(1);

    await request(app)
      .get(teamPath(report.staff.id, "/details"))
      .set(authHeader(head.token))
      .expect(404);
  });

  it("puts department people on My team next to direct reports", async () => {
    const { owner, head, member, report, setHead } = await company();
    await setHead(owner.token, head.staff.id).expect(200);

    const team = apiData<{
      members: Array<{ staffId: string; relation: string; departmentName: string | null }>;
      departments: Array<{ name: string }>;
    }>(
      await request(app)
        .get(`/v1/my-work/${head.staff.id}/team`)
        .set(authHeader(head.token))
        .expect(200)
    );

    expect(team.members.map(({ staffId, relation }) => [staffId, relation])).toEqual([
      [member.staff.id, "department"],
      [report.staff.id, "report"],
    ]);
    expect(team.departments.map(({ name }) => name)).toEqual(["Engineering"]);
    const overview = apiData<{ records: Array<{ staffId: string; hasTeam: boolean }> }>(
      await request(app).get("/v1/my-work").set(authHeader(head.token)).expect(200)
    );
    expect(overview.records.find((r) => r.staffId === head.staff.id)?.hasTeam).toBe(true);
  });

  it("takes the department away once the head's employment ends", async () => {
    const { owner, org, head, member, engineering, setHead, teamPath } = await company();
    await setHead(owner.token, head.staff.id).expect(200);

    await endStaff(app, owner.token, org.id, head.staff.id, "2026-02-01");

    const department = await testDataSource
      .getRepository(Department)
      .findOneByOrFail({ id: engineering.id });
    expect(department.headStaffId).toBeNull();
    await request(app).get(teamPath(member.staff.id)).set(authHeader(head.token)).expect(404);
  });
});
