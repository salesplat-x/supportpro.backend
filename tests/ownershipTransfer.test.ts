/**
 * An admin changing a company's creator: who gets what, what moves, and how billing follows.
 */

import crypto from "crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  Job,
  Notification,
  Organization,
  OrganizationMember,
  Payment,
  StaffHrAssignment,
  Subscription,
  User,
} from "../src/entities";
import { OrganizationOwnershipTransfer } from "../src/entities/OrganizationOwnershipTransfer.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import {
  createAdmin,
  createJob,
  createPayment,
  createPlan,
  createRecruiter,
  createRole,
  createSubscription,
  createTalent,
} from "./helpers/fixtures.js";
import { apiData } from "./helpers/http.js";
import { createStaff, staffPath } from "./helpers/staff.js";
import {
  BillingInterval,
  BillingStatus,
  Currency,
  PlanChangeReason,
  SubscriptionStatus,
} from "../src/types/enums.js";
import { computeBillingPeriodEnd, setOrganizationBilling } from "../src/services/billingState.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  __esModule: true,
  createEmbedding: jest.fn(),
}));

jest.mock("../src/utils/integrations/email/emailService.js", () => {
  const sendPeopleUpdate = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    sendPeopleUpdate,
    default: jest.fn().mockImplementation(() => ({
      sendPeopleUpdate,
      sendEmail: jest.fn(),
      sendPaymentConfirmation: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

const email = jest.requireMock("../src/utils/integrations/email/emailService.js") as {
  sendPeopleUpdate: jest.Mock;
};

const WEBHOOK_PATH = "/v1/payments/webhook";

const signBody = (body: unknown) =>
  crypto
    .createHmac("sha512", process.env["PAYSTACK_SECRET_KEY"]!)
    .update(JSON.stringify(body))
    .digest("hex");

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
  email.sendPeopleUpdate.mockResolvedValue(undefined);
});

async function company() {
  const admin = await createAdmin();
  const { owner, org } = await setupCompany();
  await testDataSource.getRepository(OrganizationMember).save({
    userId: owner.user.id,
    organizationId: org.id,
    workEmail: owner.user.email,
    role: "owner",
  });
  const next = await addMember(org, { firstName: "Nia", lastName: "Next", canManagePeople: true });
  return { admin, owner, org, next };
}

const change = (token: string, orgId: string, body: Record<string, unknown>) =>
  request(app).patch(`/v1/admin/organizations/${orgId}/owner`).set(authHeader(token)).send(body);

const orgOf = (id: string) => testDataSource.getRepository(Organization).findOneByOrFail({ id });
const roleOf = async (userId: string, organizationId: string) =>
  (await testDataSource.getRepository(OrganizationMember).findOneBy({ userId, organizationId }))
    ?.role;

describe("changing the creator", () => {
  it("swaps the creator and both roles, and keeps the old creator on the team", async () => {
    const { admin, owner, org, next } = await company();

    const res = await change(admin.token, org.id, {
      newOwnerUserId: next.user.id,
      reason: "The founder left the company.",
    });

    expect(res.status).toBe(200);
    expect((await orgOf(org.id)).ownerId).toBe(next.user.id);
    expect(await roleOf(next.user.id, org.id)).toBe("owner");
    expect(await roleOf(owner.user.id, org.id)).toBe("member");
    const oldRow = await testDataSource
      .getRepository(OrganizationMember)
      .findOneByOrFail({ userId: owner.user.id, organizationId: org.id });
    expect(oldRow.canManagePeople).toBe(false);
  });

  it("adds a row for an old creator who never had one", async () => {
    const { admin, owner, org, next } = await company();
    await testDataSource
      .getRepository(OrganizationMember)
      .delete({ userId: owner.user.id, organizationId: org.id });

    await change(admin.token, org.id, { newOwnerUserId: next.user.id, reason: "Left." }).expect(
      200
    );

    const row = await testDataSource
      .getRepository(OrganizationMember)
      .findOneByOrFail({ userId: owner.user.id, organizationId: org.id });
    expect(row.role).toBe("member");
    expect(row.workEmail).toBe(owner.user.email);
  });

  it("moves pay and contracts to the new creator straight away", async () => {
    const { admin, owner, org, next } = await company();
    const staff = await createStaff(app, owner.token, org.id);
    const pay = staffPath(org.id, `/${staff.id}/pay`);
    expect((await request(app).get(pay).set(authHeader(next.token))).status).toBe(403);

    await change(admin.token, org.id, { newOwnerUserId: next.user.id, reason: "Left." }).expect(
      200
    );

    expect((await request(app).get(pay).set(authHeader(next.token))).status).toBe(200);
    expect((await request(app).get(pay).set(authHeader(owner.token))).status).toBe(403);
    const documents = staffPath(org.id, `/${staff.id}/documents`);
    expect((await request(app).get(documents).set(authHeader(next.token))).status).toBe(200);
    expect((await request(app).get(documents).set(authHeader(owner.token))).status).toBe(403);
  });

  it("keeps a former creator's assignments, so they can still track those people", async () => {
    const { admin, owner, org, next } = await company();
    const staff = await createStaff(app, owner.token, org.id);
    await request(app)
      .put(staffPath(org.id, "/hr-assignments"))
      .set(authHeader(owner.token))
      .send({ assigneeUserId: owner.user.id, add: [staff.id] })
      .expect(200);

    await change(admin.token, org.id, { newOwnerUserId: next.user.id, reason: "Left." }).expect(
      200
    );

    expect(await testDataSource.getRepository(StaffHrAssignment).count()).toBe(1);
    const perf = staffPath(org.id, `/${staff.id}/performance`);
    expect((await request(app).get(perf).set(authHeader(owner.token))).status).toBe(200);
  });

  it("records the change, and shows it with the plan warning on the admin page", async () => {
    const { admin, owner, org, next } = await company();
    const plan = await createPlan({ planKey: "pro", interval: BillingInterval.Monthly });
    await createSubscription(owner.user, plan, {
      organizationId: org.id,
      status: SubscriptionStatus.Active,
    });

    await change(admin.token, org.id, { newOwnerUserId: next.user.id, reason: "Left." }).expect(
      200
    );

    const res = await request(app)
      .get(`/v1/admin/organizations/${org.id}`)
      .set(authHeader(admin.token));
    const { organization } = apiData<{
      organization: {
        ownershipTransfers: Array<{ fromName: string; toName: string; reason: string }>;
        activeSubscription: { planName: string | null } | null;
      };
    }>(res);
    expect(organization.ownershipTransfers).toHaveLength(1);
    expect(organization.ownershipTransfers[0]).toEqual(
      expect.objectContaining({ fromName: "Olu Owner", toName: "Nia Next", reason: "Left." })
    );
    expect(organization.activeSubscription).not.toBeNull();
  });

  it("tells both people, in the app and by email", async () => {
    const { admin, owner, org, next } = await company();

    await change(admin.token, org.id, { newOwnerUserId: next.user.id, reason: "Left." }).expect(
      200
    );

    for (const user of [owner.user, next.user]) {
      expect(
        await testDataSource
          .getRepository(Notification)
          .count({ where: { userId: user.id, type: "ownership_changed" } })
      ).toBe(1);
      expect(email.sendPeopleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ to: user.email })
      );
    }
  });

  it("warns the old creator that their card keeps paying", async () => {
    const { admin, owner, org, next } = await company();
    const plan = await createPlan({ planKey: "pro", interval: BillingInterval.Monthly });
    await createSubscription(owner.user, plan, {
      organizationId: org.id,
      status: SubscriptionStatus.Active,
    });

    await change(admin.token, org.id, { newOwnerUserId: next.user.id, reason: "Left." }).expect(
      200
    );

    const toOld = email.sendPeopleUpdate.mock.calls.find(
      ([details]) => (details as { to: string }).to === owner.user.email
    )?.[0] as { paragraphs: string[] };
    expect(toOld.paragraphs.join(" ")).toContain("Your card keeps paying");
  });

  it("still changes the creator when an email fails", async () => {
    const { admin, org, next } = await company();
    email.sendPeopleUpdate.mockRejectedValue(new Error("Resend is down"));

    const res = await change(admin.token, org.id, {
      newOwnerUserId: next.user.id,
      reason: "Left.",
    });

    expect(res.status).toBe(200);
    expect((await orgOf(org.id)).ownerId).toBe(next.user.id);
  });
});

describe("what's refused", () => {
  it("refuses anyone but the admin, even the creator", async () => {
    const { owner, org, next } = await company();

    const byOwner = await change(owner.token, org.id, {
      newOwnerUserId: next.user.id,
      reason: "Handing over.",
    });

    expect(byOwner.status).toBe(403);
    expect((await orgOf(org.id)).ownerId).toBe(owner.user.id);
  });

  it("refuses someone who isn't on the team, and an employee on a talent account", async () => {
    const { admin, org, owner } = await company();
    const outsider = await createRecruiter();
    const talent = await createTalent();

    expect(
      (await change(admin.token, org.id, { newOwnerUserId: outsider.user.id, reason: "Left." }))
        .status
    ).toBe(404);
    expect(
      (await change(admin.token, org.id, { newOwnerUserId: talent.user.id, reason: "Left." }))
        .status
    ).toBe(404);
    expect((await orgOf(org.id)).ownerId).toBe(owner.user.id);
  });

  it("refuses a talent account even with a team row", async () => {
    const { admin, org } = await company();
    const talent = await createTalent();
    await testDataSource.getRepository(OrganizationMember).save({
      userId: talent.user.id,
      organizationId: org.id,
      workEmail: talent.user.email,
      role: "member",
    });

    const res = await change(admin.token, org.id, {
      newOwnerUserId: talent.user.id,
      reason: "Left.",
    });

    expect(res.status).toBe(400);
  });

  it("refuses an inactive or unverified account", async () => {
    const { admin, org, next } = await company();

    await testDataSource.getRepository(User).update(next.user.id, { active: false });
    expect(
      (await change(admin.token, org.id, { newOwnerUserId: next.user.id, reason: "Left." })).status
    ).toBe(400);

    await testDataSource
      .getRepository(User)
      .update(next.user.id, { active: true, emailVerifiedAt: null });
    expect(
      (await change(admin.token, org.id, { newOwnerUserId: next.user.id, reason: "Left." })).status
    ).toBe(400);
  });

  it("refuses the current creator, an unknown company and a missing reason", async () => {
    const { admin, owner, org, next } = await company();

    expect(
      (await change(admin.token, org.id, { newOwnerUserId: owner.user.id, reason: "Left." })).status
    ).toBe(409);
    expect(
      (
        await change(admin.token, "9f3b1f7e-1111-4222-8333-444444444444", {
          newOwnerUserId: next.user.id,
          reason: "Left.",
        })
      ).status
    ).toBe(404);
    expect(
      (await change(admin.token, org.id, { newOwnerUserId: next.user.id, reason: " " })).status
    ).toBe(400);
    expect(
      (await change(admin.token, org.id, { newOwnerUserId: "nope", reason: "Left." })).status
    ).toBe(400);
    expect(
      (await change(admin.token, "nope", { newOwnerUserId: next.user.id, reason: "Left." })).status
    ).toBe(400);
  });
});

describe("protecting company records", () => {
  it("moves the old creator's company records, so deleting their account keeps them", async () => {
    const { admin, owner, org, next } = await company();
    const role = await createRole();
    const job = await createJob(owner.user, role, { organizationId: org.id });
    const plan = await createPlan({ planKey: "pro", interval: BillingInterval.Monthly });
    const subscription = await createSubscription(owner.user, plan, {
      organizationId: org.id,
      status: SubscriptionStatus.Active,
    });
    const payment = await createPayment(owner.user, plan, { organizationId: org.id });

    await change(admin.token, org.id, { newOwnerUserId: next.user.id, reason: "Left." }).expect(
      200
    );
    await testDataSource.query(`DELETE FROM notifications WHERE user_id = $1`, [owner.user.id]);

    await request(app)
      .delete(`/v1/admin/recruiters/${owner.user.id}`)
      .set(authHeader(admin.token))
      .expect(200);

    const savedJob = await testDataSource.getRepository(Job).findOneByOrFail({ id: job.id });
    expect(savedJob.postedById).toBe(next.user.id);
    const savedSubscription = await testDataSource
      .getRepository(Subscription)
      .findOneByOrFail({ id: subscription.id });
    expect(savedSubscription.userId).toBe(next.user.id);
    expect(savedSubscription.status).toBe(SubscriptionStatus.Active);
    expect(
      (await testDataSource.getRepository(Payment).findOneByOrFail({ id: payment.id })).userId
    ).toBe(next.user.id);
    expect((await orgOf(org.id)).ownerId).toBe(next.user.id);
    const [history] = await testDataSource.getRepository(OrganizationOwnershipTransfer).find();
    expect(history?.fromUserId).toBeNull();
    expect(history?.fromName).toBe("Olu Owner");
  });
});

describe("taking over the plan", () => {
  const onPlan = async (setup: Awaited<ReturnType<typeof company>>, startDate: Date) => {
    const plan = await createPlan({
      planKey: "pro",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 30_000_000,
    });
    await setOrganizationBilling(
      setup.org.id,
      {
        billingPlan: "pro",
        billingInterval: BillingInterval.Monthly,
        billingStatus: BillingStatus.Active,
        billingPeriodEnd: computeBillingPeriodEnd(new Date(), BillingInterval.Monthly),
      },
      { reason: PlanChangeReason.Purchase }
    );
    const subscription = await createSubscription(setup.owner.user, plan, {
      organizationId: setup.org.id,
      status: SubscriptionStatus.Active,
      startDate,
    });
    return { plan, subscription };
  };

  const buy = (token: string) =>
    request(app)
      .post("/v1/payments/")
      .set(authHeader(token))
      .send({ planKey: "pro", interval: "monthly" });

  const disableWebhook = (code: string) => {
    const body = {
      event: "subscription.disable",
      data: { id: 90, subscription_code: code },
    };
    return request(app).post(WEBHOOK_PATH).set("x-paystack-signature", signBody(body)).send(body);
  };

  it("still refuses buying the same plan when no creator change happened", async () => {
    const setup = await company();
    await onPlan(setup, new Date());

    expect((await buy(setup.owner.token)).status).toBe(409);
  });

  it("lets the new creator buy the same plan after the change", async () => {
    const setup = await company();
    await onPlan(setup, new Date(Date.now() - 60_000));
    await change(setup.admin.token, setup.org.id, {
      newOwnerUserId: setup.next.user.id,
      reason: "Left.",
    }).expect(200);

    const res = await buy(setup.next.token);

    expect(res.status).not.toBe(409);
  });

  it("refuses buying again once the new creator's own subscription is running", async () => {
    const setup = await company();
    await onPlan(setup, new Date(Date.now() - 60_000));
    await change(setup.admin.token, setup.org.id, {
      newOwnerUserId: setup.next.user.id,
      reason: "Left.",
    }).expect(200);
    await testDataSource
      .getRepository(Subscription)
      .update({ organizationId: setup.org.id }, { startDate: new Date(Date.now() + 60_000) });

    expect((await buy(setup.next.token)).status).toBe(409);
  });

  it("cancels the old card once the new creator pays, without downgrading the company", async () => {
    const setup = await company();
    const { subscription } = await onPlan(setup, new Date(Date.now() - 60_000));
    await change(setup.admin.token, setup.org.id, {
      newOwnerUserId: setup.next.user.id,
      reason: "Left.",
    }).expect(200);

    const checkout = await buy(setup.next.token);
    expect(checkout.status).toBe(200);
    const during = await testDataSource
      .getRepository(Subscription)
      .findOneByOrFail({ id: subscription.id });
    expect(during.status).toBe(SubscriptionStatus.Active);

    await request(app)
      .post("/v1/payments/verify")
      .set(authHeader(setup.next.token))
      .send({ reference: (checkout.body as { data: { reference: string } }).data.reference })
      .expect(200);

    const replaced = await testDataSource
      .getRepository(Subscription)
      .findOneByOrFail({ id: subscription.id });
    expect(replaced.status).toBe(SubscriptionStatus.Cancelled);
    expect(replaced.history?.at(-1)?.description).toBe(
      "Replaced after the company's creator changed"
    );

    await disableWebhook(subscription.paystackSubscriptionCode).expect(200);

    expect((await orgOf(setup.org.id)).billingPlan).toBe("pro");
  });

  it("still downgrades when a plan is simply cancelled", async () => {
    const setup = await company();
    const { subscription } = await onPlan(setup, new Date());

    await disableWebhook(subscription.paystackSubscriptionCode).expect(200);

    expect((await orgOf(setup.org.id)).billingPlan).not.toBe("pro");
  });
});
