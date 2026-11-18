import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { PayPackage, PayPeriod, ShareGrant, StaffAccessLog } from "../src/entities";
import { payParagraph } from "../src/services/pay.js";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createStaff, staffPath, today } from "./helpers/staff.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendStaffInvite: jest.fn().mockResolvedValue(undefined),
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

interface PayView {
  currentPackageId: string | null;
  packages: {
    id: string;
    startsOn: string;
    baseSalary: number;
    bonus: number;
    commissionTarget: number;
    totalYearly: number;
    paragraph: string;
    benefits: { name: string }[];
  }[];
  grants: { id: string }[];
}

const packageBody = (overrides: Record<string, unknown> = {}) => ({
  currency: "NGN",
  period: "monthly",
  baseSalary: 400000,
  bonusPerYear: 0,
  commissionTargetPerYear: 0,
  startsOn: "2026-01-05",
  benefitIds: [],
  ...overrides,
});

const payLogs = (staffId: string) =>
  testDataSource
    .getRepository(StaffAccessLog)
    .find({ where: { staffId, resource: "pay" as never } });

async function companyWithStaff() {
  const { owner, org } = await setupCompany();
  const staff = await createStaff(app, owner.token, org.id);
  return { owner, org, staff };
}

const putPay = (token: string, orgId: string, staffId: string, body = packageBody()) =>
  request(app)
    .put(staffPath(orgId, `/${staffId}/pay`))
    .set(authHeader(token))
    .send(body);

const getPay = (token: string, orgId: string, staffId: string) =>
  request(app)
    .get(staffPath(orgId, `/${staffId}/pay`))
    .set(authHeader(token));

describe("pay paragraph", () => {
  it("writes a monthly package with benefits", () => {
    expect(
      payParagraph(
        {
          currency: "NGN",
          period: PayPeriod.Monthly,
          baseSalary: 400000,
          bonus: 50000,
          commissionTarget: 0,
          startsOn: "2027-03-01",
        },
        ["Health cover", "Transport"]
      )
    ).toBe(
      "Your base salary is NGN 400,000 per month. You are eligible for a bonus of NGN 50,000 per year. This package starts on 1 March 2027. You also receive: Health cover, Transport."
    );
  });

  it("leaves out the bonus and benefits when there are none", () => {
    expect(
      payParagraph(
        {
          currency: "NGN",
          period: PayPeriod.Yearly,
          baseSalary: 6000000.5,
          bonus: 0,
          commissionTarget: 0,
          startsOn: "2026-12-31",
        },
        []
      )
    ).toBe(
      "Your base salary is NGN 6,000,000.50 per year. This package starts on 31 December 2026."
    );
  });

  it("includes the commission target", () => {
    expect(
      payParagraph(
        {
          currency: "USD",
          period: PayPeriod.Monthly,
          baseSalary: 3000,
          bonus: 0,
          commissionTarget: 10000,
          startsOn: "2026-02-01",
        },
        []
      )
    ).toBe(
      "Your base salary is USD 3,000 per month. Your commission target is USD 10,000 per year. This package starts on 1 February 2026."
    );
  });
});

describe("bonus and commission target are yearly", () => {
  it("stores yearly amounts and totals a year of pay", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const res = await putPay(
      owner.token,
      org.id,
      staff.id,
      packageBody({ baseSalary: 350000, bonusPerYear: 600000, commissionTargetPerYear: 600000 })
    );
    expect(res.status).toBe(200);
    const pkg = apiData<PayView>(res).packages[0]!;
    expect(pkg).toMatchObject({ bonus: 600000, commissionTarget: 600000, totalYearly: 5400000 });
    expect(pkg.paragraph).toContain("a bonus of NGN 600,000 per year");

    const row = await testDataSource.getRepository(PayPackage).findOneByOrFail({ id: pkg.id });
    expect(row).toMatchObject({ bonus: 600000, extrasYearly: true });
  });

  it("reads a package saved before the change as twelve months of bonus and target", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const saved = apiData<PayView>(
      await putPay(owner.token, org.id, staff.id, packageBody({ baseSalary: 300000 }))
    ).packages[0]!;
    await testDataSource
      .getRepository(PayPackage)
      .update(saved.id, { bonus: 50000, commissionTarget: 10000.5, extrasYearly: false });

    const pkg = apiData<PayView>(await getPay(owner.token, org.id, staff.id)).packages[0]!;
    expect(pkg).toMatchObject({ bonus: 600000, commissionTarget: 120006, totalYearly: 4320006 });

    const yearly = apiData<PayView>(
      await putPay(
        owner.token,
        org.id,
        staff.id,
        packageBody({ baseSalary: 300000, bonusPerYear: 600000 })
      )
    ).packages;
    expect(yearly).toHaveLength(1);
    const row = await testDataSource.getRepository(PayPackage).findOneByOrFail({ id: saved.id });
    expect(row).toMatchObject({ bonus: 600000, commissionTarget: 0, extrasYearly: true });
  });

  it("does not multiply an old yearly package", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const saved = apiData<PayView>(
      await putPay(owner.token, org.id, staff.id, packageBody({ period: "yearly", baseSalary: 1 }))
    ).packages[0]!;
    await testDataSource
      .getRepository(PayPackage)
      .update(saved.id, { bonus: 50000, extrasYearly: false });
    const pkg = apiData<PayView>(await getPay(owner.token, org.id, staff.id)).packages[0]!;
    expect(pkg.bonus).toBe(50000);
  });

  it("refuses a save that sends the old field names or leaves the yearly amounts out", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const { bonusPerYear: _b, commissionTargetPerYear: _c, ...old } = packageBody();
    expect(
      (
        await putPay(owner.token, org.id, staff.id, {
          ...old,
          bonus: 1,
          commissionTarget: 1,
        } as never)
      ).status
    ).toBe(400);
    expect(
      (await putPay(owner.token, org.id, staff.id, packageBody({ bonusPerYear: -1 }))).status
    ).toBe(400);
    expect(apiData<PayView>(await getPay(owner.token, org.id, staff.id)).packages).toHaveLength(0);
  });
});

describe("pay access", () => {
  it("refuses a member without Can manage people and logs nothing", async () => {
    const { org, staff } = await companyWithStaff();
    const plain = await addMember(org);

    expect((await getPay(plain.token, org.id, staff.id)).status).toBe(403);
    expect((await putPay(plain.token, org.id, staff.id)).status).toBe(403);
    expect(await payLogs(staff.id)).toHaveLength(0);
  });

  it("keeps pay from a member with Can manage people", async () => {
    const { org, staff } = await companyWithStaff();
    const hr = await addMember(org, { canManagePeople: true });

    expect((await getPay(hr.token, org.id, staff.id)).status).toBe(403);
    expect((await putPay(hr.token, org.id, staff.id)).status).toBe(403);
    expect(await payLogs(staff.id)).toHaveLength(0);
  });

  it("writes one pay line per read and hides other companies' staff", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const other = await setupCompany("Other Ltd");

    expect((await getPay(owner.token, org.id, staff.id)).status).toBe(200);
    expect(await payLogs(staff.id)).toHaveLength(1);
    expect((await getPay(other.owner.token, other.org.id, staff.id)).status).toBe(404);
    expect((await getPay(owner.token, org.id, staff.id)).status).toBe(200);
    expect(await payLogs(staff.id)).toHaveLength(2);
  });
});

describe("pay packages", () => {
  it("replaces a package with the same start date and keeps history otherwise", async () => {
    const { owner, org, staff } = await companyWithStaff();
    expect((await putPay(owner.token, org.id, staff.id)).status).toBe(200);
    expect(
      (await putPay(owner.token, org.id, staff.id, packageBody({ baseSalary: 450000 }))).status
    ).toBe(200);
    expect(
      (
        await putPay(
          owner.token,
          org.id,
          staff.id,
          packageBody({ startsOn: "2099-01-01", baseSalary: 500000 })
        )
      ).status
    ).toBe(200);

    const pay = apiData<PayView>(await getPay(owner.token, org.id, staff.id));
    expect(pay.packages.map((p) => [p.startsOn, p.baseSalary])).toEqual([
      ["2099-01-01", 500000],
      ["2026-01-05", 450000],
    ]);
    expect(pay.currentPackageId).toBe(pay.packages[1]?.id);
  });

  it("keeps one package when the same save arrives twice at once", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const results = await Promise.all([
      putPay(owner.token, org.id, staff.id),
      putPay(owner.token, org.id, staff.id),
    ]);

    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(apiData<PayView>(await getPay(owner.token, org.id, staff.id)).packages).toHaveLength(1);
  });

  it("falls back to the earliest future package when none has started", async () => {
    const { owner, org, staff } = await companyWithStaff();
    await putPay(owner.token, org.id, staff.id, packageBody({ startsOn: "2099-06-01" }));
    await putPay(owner.token, org.id, staff.id, packageBody({ startsOn: "2099-01-01" }));

    const pay = apiData<PayView>(await getPay(owner.token, org.id, staff.id));
    expect(pay.packages.find((p) => p.id === pay.currentPackageId)?.startsOn).toBe("2099-01-01");
  });

  it("links benefits, refuses another company's benefit and drops deleted ones", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const other = await setupCompany("Other Ltd");
    const benefit = (token: string, orgId: string, name: string) =>
      request(app).post(staffPath(orgId, "/benefits")).set(authHeader(token)).send({ name });

    const health = apiData<{ benefit: { id: string } }>(
      await benefit(owner.token, org.id, "Health cover")
    ).benefit;
    expect((await benefit(owner.token, org.id, "health COVER")).status).toBe(409);
    const foreign = apiData<{ benefit: { id: string } }>(
      await benefit(other.owner.token, other.org.id, "Gym")
    ).benefit;

    expect(
      (await putPay(owner.token, org.id, staff.id, packageBody({ benefitIds: [foreign.id] })))
        .status
    ).toBe(400);
    expect(
      (await putPay(owner.token, org.id, staff.id, packageBody({ benefitIds: [health.id] }))).status
    ).toBe(200);
    let pay = apiData<PayView>(await getPay(owner.token, org.id, staff.id));
    expect(pay.packages[0]?.paragraph).toContain("You also receive: Health cover.");

    await request(app)
      .delete(staffPath(org.id, `/benefits/${health.id}`))
      .set(authHeader(owner.token))
      .expect(200);
    pay = apiData<PayView>(await getPay(owner.token, org.id, staff.id));
    expect(pay.packages[0]?.benefits).toEqual([]);
  });

  it("refuses pay changes for someone whose employment has ended", async () => {
    const { owner, org, staff } = await companyWithStaff();
    await request(app)
      .post(staffPath(org.id, `/${staff.id}/end`))
      .set(authHeader(owner.token))
      .send({ endDate: today() })
      .expect(200);

    expect((await putPay(owner.token, org.id, staff.id)).status).toBe(409);
  });
});

describe("share grants", () => {
  const grantBody = (overrides: Record<string, unknown> = {}) => ({
    shares: 10000,
    grantedOn: "2026-01-31",
    cliffMonths: 12,
    vestingMonths: 48,
    strikePrice: 50,
    currency: "NGN",
    ...overrides,
  });

  it("adds and removes a grant, and refuses a cliff longer than the vesting period", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const grants = staffPath(org.id, `/${staff.id}/share-grants`);

    expect(
      (
        await request(app)
          .post(grants)
          .set(authHeader(owner.token))
          .send(grantBody({ cliffMonths: 49 }))
      ).status
    ).toBe(400);
    const created = await request(app).post(grants).set(authHeader(owner.token)).send(grantBody());
    expect(created.status).toBe(201);
    const { grant } = apiData<{ grant: { id: string; createdByName: string | null } }>(created);
    expect(grant.createdByName).toBe("Olu Owner");
    const row = await testDataSource.getRepository(ShareGrant).findOneByOrFail({ id: grant.id });
    expect(row.createdById).toBe(owner.user.id);

    await request(app).delete(`${grants}/${grant.id}`).set(authHeader(owner.token)).expect(200);
    expect(apiData<PayView>(await getPay(owner.token, org.id, staff.id)).grants).toEqual([]);
  });
});
