import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  CommissionPlan,
  Organization,
  PayPackage,
  StaffAccessLog,
  StaffMember,
} from "../src/entities";
import { StaffStatus } from "../src/entities/StaffMember.js";
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

const EXAMPLE_BANDS = [
  { fromAmount: 0, toAmount: 5_000_000, ratePercent: 5 },
  { fromAmount: 5_000_000, toAmount: 10_000_000, ratePercent: 7.5 },
  { fromAmount: 10_000_000, toAmount: null, ratePercent: 10 },
];

const planBody = (bands: unknown, name = "Sales 2027") => ({
  name,
  paidOn: "yearly_sales",
  frequency: "quarterly",
  bands,
});

const postPlan = (token: string, orgId: string, bands: unknown, name = "Sales 2027") =>
  request(app)
    .post(staffPath(orgId, "/commission-plans"))
    .set(authHeader(token))
    .send(planBody(bands, name));

describe("commission plans", () => {
  it.each([
    ["a gap", [EXAMPLE_BANDS[0], { ...EXAMPLE_BANDS[2], fromAmount: 6_000_000 }]],
    ["an overlap", [EXAMPLE_BANDS[0], { ...EXAMPLE_BANDS[2], fromAmount: 4_000_000 }]],
    ["an open tier before the last", [{ ...EXAMPLE_BANDS[0], toAmount: null }, EXAMPLE_BANDS[2]]],
    ["a first tier above 0", [{ ...EXAMPLE_BANDS[2], fromAmount: 10 }]],
    ["a rate above 100%", [{ ...EXAMPLE_BANDS[2], fromAmount: 0, ratePercent: 150 }]],
  ])("refuses tiers with %s", async (_label, bands) => {
    const { owner, org } = await setupCompany();
    expect((await postPlan(owner.token, org.id, bands)).status).toBe(400);
  });

  it("refuses a plan without a valid paid on or frequency", async () => {
    const { owner, org } = await setupCompany();
    const send = (body: object) =>
      request(app)
        .post(staffPath(org.id, "/commission-plans"))
        .set(authHeader(owner.token))
        .send({ ...planBody(EXAMPLE_BANDS), ...body });
    expect((await send({ paidOn: "bonuses" })).status).toBe(400);
    expect((await send({ frequency: "weekly" })).status).toBe(400);
  });

  it("flags a plan from before bands as needing bands until it is edited", async () => {
    const { owner, org } = await setupCompany();
    await testDataSource.getRepository(CommissionPlan).save({
      organizationId: org.id,
      name: "Legacy",
      tiers: [{ fromPercent: 0, toPercent: null, ratePercent: 5, boost: null }],
    });
    const list = async () =>
      apiData<{ plans: { id: string; needsBands: boolean }[] }>(
        await request(app).get(staffPath(org.id, "/commission-plans")).set(authHeader(owner.token))
      ).plans;

    const [legacy] = await list();
    expect(legacy?.needsBands).toBe(true);
    await request(app)
      .put(staffPath(org.id, `/commission-plans/${legacy!.id}`))
      .set(authHeader(owner.token))
      .send(planBody(EXAMPLE_BANDS, "Legacy"))
      .expect(200);
    expect((await list())[0]?.needsBands).toBe(false);
  });

  it("saves a plan, gives it to an employee and refuses to delete it while in use", async () => {
    const { owner, org } = await setupCompany();
    const other = await setupCompany("Other Ltd");
    const staff = await createStaff(app, owner.token, org.id);
    const { plan } = apiData<{ plan: { id: string } }>(
      await postPlan(owner.token, org.id, EXAMPLE_BANDS)
    );
    const foreign = apiData<{ plan: { id: string } }>(
      await postPlan(other.owner.token, other.org.id, EXAMPLE_BANDS)
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

describe("people on a plan", () => {
  it("counts current staff whose current package uses the plan", async () => {
    const { owner, org } = await setupCompany();
    const plan = (name: string) =>
      request(app)
        .post(staffPath(org.id, "/commission-plans"))
        .set(authHeader(owner.token))
        .send(planBody(EXAMPLE_BANDS, name));
    const sales = apiData<{ plan: { id: string } }>(await plan("Sales 2026")).plan;
    const product = apiData<{ plan: { id: string } }>(await plan("Product 2026")).plan;
    const [ada, bayo, chi, dayo] = await Promise.all(
      [1, 2, 3, 4].map(() => createStaff(app, owner.token, org.id))
    );

    await setPay(app, owner.token, org.id, ada!.id, { commissionPlanId: sales.id });
    await setPay(app, owner.token, org.id, bayo!.id, {
      commissionPlanId: sales.id,
      startsOn: "2025-01-01",
    });
    await setPay(app, owner.token, org.id, bayo!.id, { commissionPlanId: product.id });
    await setPay(app, owner.token, org.id, chi!.id, {
      commissionPlanId: product.id,
      startsOn: "2099-01-01",
    });
    await setPay(app, owner.token, org.id, chi!.id, {
      commissionPlanId: sales.id,
      startsOn: "2099-06-01",
    });
    await setPay(app, owner.token, org.id, dayo!.id, { commissionPlanId: sales.id });
    await request(app)
      .post(staffPath(org.id, `/${dayo!.id}/end`))
      .set(authHeader(owner.token))
      .send({ endDate: today() })
      .expect(200);

    const plans = apiData<{ plans: { name: string; peopleCount: number; people: string[] }[] }>(
      await request(app).get(staffPath(org.id, "/commission-plans")).set(authHeader(owner.token))
    ).plans;
    expect(plans.map((p) => [p.name, p.peopleCount])).toEqual([
      ["Product 2026", 2],
      ["Sales 2026", 1],
    ]);
    expect(plans[0]?.people).toHaveLength(2);
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
    await setPay(app, owner.token, org.id, ada!.id, {
      baseSalary: 100000,
      bonusPerYear: 120000,
    });
    await setPay(app, owner.token, org.id, bayo!.id, { period: "yearly", baseSalary: 2000000 });
    await setPay(app, owner.token, org.id, chi!.id, {
      currency: "USD",
      baseSalary: 1000,
      commissionTargetPerYear: 6000,
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

  it("counts a package saved before bonus became yearly as twelve months of it", async () => {
    const { owner, org } = await setupCompany();
    const ada = await createStaff(app, owner.token, org.id, { department: "Design" });
    await setPay(app, owner.token, org.id, ada.id, { baseSalary: 100000 });
    await testDataSource
      .getRepository(PayPackage)
      .update({ staffId: ada.id }, { bonus: 10000, commissionTarget: 500, extrasYearly: false });

    const cost = apiData<{ totals: { bonus: number; commissionTarget: number; total: number }[] }>(
      await request(app).get(staffPath(org.id, "/headcount-cost")).set(authHeader(owner.token))
    );
    expect(cost.totals[0]).toMatchObject({ bonus: 120000, commissionTarget: 6000, total: 1326000 });
  });

  it("counts headcount at each month end with who is invited and who left", async () => {
    const { owner, org } = await setupCompany();
    const monthStart = (back: number) => {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
        .toISOString()
        .slice(0, 10);
    };
    const person = (fullName: string) => createStaff(app, owner.token, org.id, { fullName });
    const [ada, bayo, chi, dayo] = [
      await person("Ada Obi"),
      await person("Bayo Ade"),
      await person("Chi Eze"),
      await person("Dayo Ola"),
    ];
    const staff = testDataSource.getRepository(StaffMember);
    await staff.update({ id: ada.id }, { startDate: monthStart(14) });
    await staff.update({ id: bayo.id }, { startDate: monthStart(3) });
    await staff.update(
      { id: chi.id },
      { startDate: monthStart(8), endDate: monthStart(2), status: StaffStatus.Ended }
    );
    await staff.update({ id: dayo.id }, { startDate: monthStart(-1), status: StaffStatus.Invited });

    const get = (query = "") =>
      request(app)
        .get(staffPath(org.id, `/headcount-cost${query}`))
        .set(authHeader(owner.token));
    const cost = apiData<{
      headcount: number;
      invited: { count: number; names: string[] };
      left: { count: number; names: string[] };
      byMonth: { month: string; headcount: number }[];
    }>(await get());

    expect(cost.byMonth.map((row) => row.headcount)).toEqual([1, 1, 1, 2, 2, 2, 2, 2, 3, 2, 2, 2]);
    expect(cost.headcount).toBe(2);
    expect(cost.invited).toEqual({ count: 1, names: ["Dayo Ola"] });
    expect(cost.left).toEqual({ count: 1, names: ["Chi Eze"] });

    const short = apiData<{ byMonth: unknown[]; left: { count: number } }>(await get("?months=3"));
    expect(short.byMonth).toHaveLength(3);
    expect(short.left.count).toBe(1);
    expect((await get("?months=5")).status).toBe(400);
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
