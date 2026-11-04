import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { StaffAccessLog } from "../src/entities";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { apiData } from "./helpers/http.js";
import { createStaff, staffPath, today } from "./helpers/staff.js";
import { companyWithTeam, endStaff } from "./helpers/team.js";

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

interface Person {
  id: string;
  fullName: string;
  jobTitle: string;
  managerId: string | null;
  managerLeft: boolean;
}

const chart = (token: string, orgId: string) =>
  request(app).get(staffPath(orgId, "/org-chart")).set(authHeader(token));

const people = async (token: string, orgId: string) =>
  apiData<{ people: Person[]; truncated: boolean }>(await chart(token, orgId).expect(200)).people;

describe("org chart", () => {
  it("lists current staff with their managers and updates when a manager changes", async () => {
    const company = await companyWithTeam();
    const { manager, report, colleague } = await company.build(app);
    const { owner, org } = company;

    const before = await people(owner.token, org.id);
    expect(before.find((person) => person.id === report.staff.id)).toMatchObject({
      fullName: "Ada Obi",
      managerId: manager.staff.id,
      managerLeft: false,
    });

    await request(app)
      .patch(staffPath(org.id, `/${report.staff.id}`))
      .set(authHeader(owner.token))
      .send({ managerId: colleague.staff.id })
      .expect(200);
    const after = await people(owner.token, org.id);
    expect(after.find((person) => person.id === report.staff.id)!.managerId).toBe(
      colleague.staff.id
    );
  });

  it("flags people whose manager left and leaves ended staff out", async () => {
    const company = await companyWithTeam();
    const { manager, report } = await company.build(app);
    const { owner, org } = company;
    await endStaff(app, owner.token, org.id, manager.staff.id, today());

    const list = await people(owner.token, org.id);
    expect(list.map((person) => person.id)).not.toContain(manager.staff.id);
    expect(list.find((person) => person.id === report.staff.id)).toMatchObject({
      managerId: null,
      managerLeft: true,
    });
  });

  it("refuses a reporting loop made through the chart", async () => {
    const company = await companyWithTeam();
    const { manager, report } = await company.build(app);
    const res = await request(app)
      .patch(staffPath(company.org.id, `/${manager.staff.id}`))
      .set(authHeader(company.owner.token))
      .send({ managerId: report.staff.id });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("is for HR only, per company, and writes no log line", async () => {
    const company = await companyWithTeam();
    const { report, manager } = await company.build(app);
    const { owner, org } = company;
    const other = await setupCompany("Other Ltd");
    const plainMember = await addMember(org);
    const hr = await addMember(org, { canManagePeople: true });
    await createStaff(app, other.owner.token, other.org.id, { fullName: "Stranger" });

    expect((await chart(plainMember.token, org.id)).status).toBe(403);
    expect((await chart(other.owner.token, org.id)).status).toBe(403);
    expect((await chart(report.token, org.id)).status).toBe(403);
    expect((await chart(manager.token, org.id)).status).toBe(403);
    expect((await request(app).get(staffPath(org.id, "/org-chart"))).status).toBe(401);
    expect((await chart(hr.token, org.id)).status).toBe(200);
    expect((await people(owner.token, org.id)).map((p) => p.fullName)).not.toContain("Stranger");
    expect(await testDataSource.getRepository(StaffAccessLog).count()).toBe(0);
  });

  it("marks the list as cut off above 5,000 people", async () => {
    const { owner, org } = await setupCompany();
    await testDataSource.query(
      `INSERT INTO staff_members (organization_id, full_name, email, job_title, start_date, status, hired_through_auxhr, is_executive)
       SELECT $1, 'Person ' || n, 'p' || n || '@example.com', 'Role', '2026-01-05', 'active', false, false
       FROM generate_series(1, 5001) AS n`,
      [org.id]
    );
    const body = apiData<{ people: Person[]; truncated: boolean }>(
      await chart(owner.token, org.id).expect(200)
    );
    expect(body.truncated).toBe(true);
    expect(body.people).toHaveLength(5000);
  });
});
