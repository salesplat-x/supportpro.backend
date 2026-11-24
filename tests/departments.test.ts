import request from "supertest";
import { createApp } from "../src/app.js";
import { Department } from "../src/entities/Department.js";
import { Organization } from "../src/entities/Organization.js";
import { StaffMember } from "../src/entities/StaffMember.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createStaff } from "./helpers/staff.js";

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

const add = (token: string, orgId: string, name: unknown) =>
  request(app).post(`/v1/organizations/${orgId}/departments`).set(authHeader(token)).send({ name });

const remove = (token: string, orgId: string, name: string) =>
  request(app)
    .delete(`/v1/organizations/${orgId}/departments/${encodeURIComponent(name)}`)
    .set(authHeader(token));

const storedDepartments = async (orgId: string) =>
  (await testDataSource.getRepository(Organization).findOneByOrFail({ id: orgId })).departments;

describe("company departments", () => {
  it("the owner adds a trimmed department and gets the full list back", async () => {
    const { owner, org } = await setupCompany();

    await add(owner.token, org.id, "Engineering").expect(201);
    const res = await add(owner.token, org.id, "  Sales  ").expect(201);

    expect(apiData<{ departments: string[] }>(res).departments).toEqual(["Engineering", "Sales"]);
    expect(await storedDepartments(org.id)).toEqual(["Engineering", "Sales"]);
  });

  it("a member with Can manage people can add and remove", async () => {
    const { org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });

    await add(hr.token, org.id, "Finance").expect(201);
    await remove(hr.token, org.id, "Finance").expect(200);

    expect(await storedDepartments(org.id)).toEqual([]);
  });

  it("a member without Can manage people → 403 and nothing changes", async () => {
    const { org } = await setupCompany();
    const recruiter = await addMember(org, { canManagePeople: false });

    await add(recruiter.token, org.id, "Finance").expect(403);

    expect(await storedDepartments(org.id)).toEqual([]);
  });

  it("a recruiter from another company cannot add → 403/404", async () => {
    const { org } = await setupCompany();
    const { owner: outsider } = await setupCompany("Other Ltd");

    const res = await add(outsider.token, org.id, "Finance");

    expect([403, 404]).toContain(res.status);
    expect(await storedDepartments(org.id)).toEqual([]);
  });

  it("a duplicate in any letter case → 409", async () => {
    const { owner, org } = await setupCompany();
    await add(owner.token, org.id, "Engineering").expect(201);

    const res = await add(owner.token, org.id, "ENGINEERING");

    expect(res.status).toBe(409);
    expect(await storedDepartments(org.id)).toEqual(["Engineering"]);
  });

  it("two people adding at the same time both keep their department", async () => {
    const { owner, org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });

    const results = await Promise.all([
      add(owner.token, org.id, "Design"),
      add(hr.token, org.id, "Support"),
      add(owner.token, org.id, "Product"),
    ]);

    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect((await storedDepartments(org.id)).sort()).toEqual(["Design", "Product", "Support"]);
  });

  it("the same name added twice at once is saved once", async () => {
    const { owner, org } = await setupCompany();

    const results = await Promise.all([
      add(owner.token, org.id, "Design"),
      add(owner.token, org.id, "design"),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await storedDepartments(org.id)).toHaveLength(1);
  });

  it("stops at 50 departments → 409", async () => {
    const { owner, org } = await setupCompany();
    const full = Array.from({ length: 50 }, (_, i) => `Team ${i + 1}`);
    await testDataSource.getRepository(Organization).update(org.id, { departments: full });
    await testDataSource
      .getRepository(Department)
      .save(full.map((name) => ({ organizationId: org.id, name })));

    const res = await add(owner.token, org.id, "One more");

    expect(res.status).toBe(409);
    expect(await storedDepartments(org.id)).toHaveLength(50);
  });

  it.each([
    ["empty", "   "],
    ["over 60 characters", "x".repeat(61)],
    ["not text", 42],
  ])("rejects a name that is %s → 400", async (_label, name) => {
    const { owner, org } = await setupCompany();

    await add(owner.token, org.id, name).expect(400);
  });

  it("removing matches any letter case, keeps the order, and is fine to repeat", async () => {
    const { owner, org } = await setupCompany();
    for (const name of ["Design", "Sales", "Support"]) {
      await add(owner.token, org.id, name).expect(201);
    }

    await remove(owner.token, org.id, "sales").expect(200);
    const again = await remove(owner.token, org.id, "sales").expect(200);

    expect(apiData<{ departments: string[] }>(again).departments).toEqual(["Design", "Support"]);
  });

  it("removing a department leaves the people who were in it with no department", async () => {
    const { owner, org } = await setupCompany();
    await add(owner.token, org.id, "Sales").expect(201);
    const staff = await createStaff(app, owner.token, org.id, { department: "Sales" });

    await remove(owner.token, org.id, "sales").expect(200);

    const stored = await testDataSource
      .getRepository(StaffMember)
      .findOneByOrFail({ id: staff.id });
    expect(stored.department).toBeNull();
    expect(stored.departmentId).toBeNull();
    expect(await testDataSource.getRepository(Department).countBy({ organizationId: org.id })).toBe(
      0
    );
  });

  it("each added department is also a row, kept in step with the list", async () => {
    const { owner, org } = await setupCompany();

    await add(owner.token, org.id, "Engineering").expect(201);

    const rows = await testDataSource.getRepository(Department).findBy({ organizationId: org.id });
    expect(rows.map((row) => row.name)).toEqual(["Engineering"]);
  });

  it("a staff write links the department in any letter case and creates a new one", async () => {
    const { owner, org } = await setupCompany();
    await add(owner.token, org.id, "Sales").expect(201);

    const existing = await createStaff(app, owner.token, org.id, { department: "sales" });
    const created = await createStaff(app, owner.token, org.id, {
      email: "ops@example.com",
      department: "Operations",
    });

    const repo = testDataSource.getRepository(StaffMember);
    const first = await repo.findOneByOrFail({ id: existing.id });
    const second = await repo.findOneByOrFail({ id: created.id });
    const departments = testDataSource.getRepository(Department);
    expect(first.department).toBe("Sales");
    expect(first.departmentId).toBe(
      (await departments.findOneByOrFail({ organizationId: org.id, name: "Sales" })).id
    );
    expect(second.departmentId).toBe(
      (await departments.findOneByOrFail({ organizationId: org.id, name: "Operations" })).id
    );
    expect(await storedDepartments(org.id)).toEqual(["Sales", "Operations"]);
  });

  it("changing someone's department moves the link", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id, { department: "Sales" });

    await request(app)
      .patch(`/v1/organizations/${org.id}/staff/${staff.id}`)
      .set(authHeader(owner.token))
      .send({ department: "Finance" })
      .expect(200);

    const stored = await testDataSource
      .getRepository(StaffMember)
      .findOneByOrFail({ id: staff.id });
    const finance = await testDataSource
      .getRepository(Department)
      .findOneByOrFail({ organizationId: org.id, name: "Finance" });
    expect(stored.departmentId).toBe(finance.id);
    expect(stored.department).toBe("Finance");
  });

  it("an import creates the departments it names once, in any letter case", async () => {
    const { owner, org } = await setupCompany();
    const row = (fullName: string, email: string, department: string) => ({
      fullName,
      email,
      jobTitle: "Analyst",
      department,
      startDate: "2026-01-05",
    });

    await request(app)
      .post(`/v1/organizations/${org.id}/staff/import`)
      .set(authHeader(owner.token))
      .send({
        commit: true,
        rows: [
          row("Ada One", "ada@example.com", "Finance"),
          row("Bo Two", "bo@example.com", "finance"),
        ],
      })
      .expect(200);

    const departments = await testDataSource
      .getRepository(Department)
      .findBy({ organizationId: org.id });
    expect(departments.map((department) => department.name)).toEqual(["Finance"]);
    const staff = await testDataSource
      .getRepository(StaffMember)
      .findBy({ organizationId: org.id });
    expect(staff.map((person) => person.departmentId)).toEqual([
      departments[0]!.id,
      departments[0]!.id,
    ]);
  });

  it("comes back with the company in GET /organizations/me", async () => {
    const { owner, org } = await setupCompany();
    await add(owner.token, org.id, "Sales").expect(201);

    const res = await request(app).get("/v1/organizations/me").set(authHeader(owner.token));

    expect(JSON.stringify(apiData(res))).toContain('"departments":["Sales"]');
  });
});
