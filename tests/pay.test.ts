import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { PayPeriod, StaffAccessLog } from "../src/entities";
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
    paragraph: string;
    benefits: { name: string }[];
  }[];
  grants: { id: string }[];
}

const packageBody = (overrides: Record<string, unknown> = {}) => ({
  currency: "NGN",
  period: "monthly",
  baseSalary: 400000,
  bonus: 0,
  commissionTarget: 0,
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
      "Your base salary is NGN 400,000 per month. You are eligible for a bonus of NGN 50,000 per month. This package starts on 1 March 2027. You also receive: Health cover, Transport."
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
      "Your base salary is USD 3,000 per month. Your commission target is USD 10,000 per month. This package starts on 1 February 2026."
    );
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

  it("writes one pay line per read and hides other companies' staff", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const hr = await addMember(org, { canManagePeople: true });
    const other = await setupCompany("Other Ltd");

    expect((await getPay(hr.token, org.id, staff.id)).status).toBe(200);
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
    const { grant } = apiData<{ grant: { id: string } }>(created);

    await request(app).delete(`${grants}/${grant.id}`).set(authHeader(owner.token)).expect(200);
    expect(apiData<PayView>(await getPay(owner.token, org.id, staff.id)).grants).toEqual([]);
  });
});
