import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { Organization, StaffAccessLog } from "../src/entities";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createStaff, setPay, staffPath, today } from "./helpers/staff.js";

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
});

const EXAMPLE_TIERS = [
  { fromPercent: 0, toPercent: 80, ratePercent: 5, boost: null },
  { fromPercent: 80, toPercent: 100, ratePercent: 8, boost: null },
  { fromPercent: 100, toPercent: null, ratePercent: 12, boost: 1.5 },
];

const postPlan = (token: string, orgId: string, tiers: unknown, name = "Sales 2027") =>
  request(app)
    .post(staffPath(orgId, "/commission-plans"))
    .set(authHeader(token))
    .send({ name, tiers });

describe("commission plans", () => {
  it.each([
    ["a gap", [EXAMPLE_TIERS[0], { ...EXAMPLE_TIERS[2], fromPercent: 85 }]],
    ["an overlap", [EXAMPLE_TIERS[0], { ...EXAMPLE_TIERS[2], fromPercent: 70 }]],
    ["an open tier before the last", [{ ...EXAMPLE_TIERS[0], toPercent: null }, EXAMPLE_TIERS[2]]],
    ["a first tier above 0%", [{ ...EXAMPLE_TIERS[2], fromPercent: 10 }]],
    ["a boost below 1x", [{ ...EXAMPLE_TIERS[2], fromPercent: 0, boost: 0.5 }]],
  ])("refuses tiers with %s", async (_label, tiers) => {
    const { owner, org } = await setupCompany();
    expect((await postPlan(owner.token, org.id, tiers)).status).toBe(400);
  });

  it("saves a plan, gives it to an employee and refuses to delete it while in use", async () => {
    const { owner, org } = await setupCompany();
    const other = await setupCompany("Other Ltd");
    const staff = await createStaff(app, owner.token, org.id);
    const { plan } = apiData<{ plan: { id: string } }>(
      await postPlan(owner.token, org.id, EXAMPLE_TIERS)
    );
    const foreign = apiData<{ plan: { id: string } }>(
      await postPlan(other.owner.token, other.org.id, EXAMPLE_TIERS)
    ).plan;

    expect(
      (await setPay(app, owner.token, org.id, staff.id, { commissionPlanId: foreign.id })).status
    ).toBe(400);
    expect(
      (await setPay(app, owner.token, org.id, staff.id, { commissionPlanId: plan.id })).status
    ).toBe(200);
    expect(
      (
        await request(app)
          .delete(staffPath(org.id, `/commission-plans/${plan.id}`))
          .set(authHeader(owner.token))
      ).status
    ).toBe(409);
    await request(app)
      .delete(`/v1/organizations/${org.id}`)
      .set(authHeader(owner.token))
      .expect(200);
    expect(await testDataSource.getRepository(Organization).exists({ where: { id: org.id } })).toBe(
      false
    );
  });
});

describe("headcount cost", () => {
  it("adds up each person's current yearly pay by department and currency", async () => {
    const { owner, org } = await setupCompany();
    const staff = (department: string) => createStaff(app, owner.token, org.id, { department });
    const [ada, bayo, chi, dayo, ese] = await Promise.all([
      staff("Design"),
      staff("Design"),
      staff("Sales"),
      staff("Design"),
      staff("Design"),
    ]);

    await setPay(app, owner.token, org.id, ada!.id, { baseSalary: 50000, startsOn: "2025-01-01" });
    await setPay(app, owner.token, org.id, ada!.id, { baseSalary: 100000, bonus: 10000 });
    await setPay(app, owner.token, org.id, bayo!.id, { period: "yearly", baseSalary: 2000000 });
    await setPay(app, owner.token, org.id, chi!.id, {
      currency: "USD",
      baseSalary: 1000,
      commissionTarget: 500,
    });
    await setPay(app, owner.token, org.id, dayo!.id);
    await setPay(app, owner.token, org.id, ese!.id, { startsOn: "2099-01-01" });
    await request(app)
      .post(staffPath(org.id, `/${dayo!.id}/end`))
      .set(authHeader(owner.token))
      .send({ endDate: today() })
      .expect(200);

    const cost = apiData<{ totals: unknown[]; departments: unknown[] }>(
      await request(app).get(staffPath(org.id, "/headcount-cost")).set(authHeader(owner.token))
    );

    expect(cost.departments).toEqual([
      {
        currency: "NGN",
        department: "Design",
        staffCount: 2,
        baseSalary: 3200000,
        bonus: 120000,
        commissionTarget: 0,
        total: 3320000,
      },
      {
        currency: "USD",
        department: "Sales",
        staffCount: 1,
        baseSalary: 12000,
        bonus: 0,
        commissionTarget: 6000,
        total: 18000,
      },
    ]);
    expect(cost.totals).toEqual([
      expect.objectContaining({ currency: "NGN", department: null, staffCount: 2, total: 3320000 }),
      expect.objectContaining({ currency: "USD", department: null, staffCount: 1, total: 18000 }),
    ]);
  });

  it("refuses people without access and writes one log line per view", async () => {
    const { owner, org } = await setupCompany();
    const plain = await addMember(org);
    const logs = () =>
      testDataSource.getRepository(StaffAccessLog).find({ where: { organizationId: org.id } });

    expect(
      (await request(app).get(staffPath(org.id, "/headcount-cost")).set(authHeader(plain.token)))
        .status
    ).toBe(403);
    expect(await logs()).toHaveLength(0);
    await request(app)
      .get(staffPath(org.id, "/headcount-cost"))
      .set(authHeader(owner.token))
      .expect(200);
    expect(await logs()).toEqual([
      expect.objectContaining({
        resource: "headcount_cost",
        staffId: null,
        staffName: "all staff",
      }),
    ]);
  });
});
