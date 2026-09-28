import { QueryFailedError } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Payment } from "../entities/Payment.js";
import { PaymentWebhookEvent } from "../entities/PaymentWebhookEvent.js";
import { Subscription } from "../entities/Subscription.js";
import { User } from "../entities/User.js";
import { Organization } from "../entities/Organization.js";
import { Plan } from "../entities/Plan.js";
import { Job } from "../entities/Job.js";
import {
  getPlanByKey,
  getSubscriptionPlanKeys,
  loadPricingCatalog,
  ngnToKobo,
} from "../config/pricingCatalog.js";
import env from "../config/env.js";
import { NotFoundError, ValidationError, ConflictError, AuthorizationError } from "../utils/errors";
import {
  BillingInterval,
  BillingStatus,
  DEFAULT_BILLING_PLAN_KEY,
  JobStatus,
  PaymentStatus,
  PlanChangeReason,
  SubscriptionStatus,
} from "../types/enums.js";
import {
  initializePayment,
  verifyTransaction,
  generatePaymentObject,
  createCustomer,
  disableSubscription as paystackDisableSubscription,
  isDummyPaystack,
} from "../utils/integrations/paystack.js";
import {
  computeBillingPeriodEnd,
  resetPeriodUsage,
  revertToPayPerUseIfStillOnPlan,
  setOrganizationBilling,
  setOrganizationBillingStatus,
} from "./billingState.js";
import { ensureOrganizationBillingCurrent } from "./entitlements.js";
import logger from "../utils/logger.js";
import { generateReference } from "../utils/crypto.js";
import EmailService from "../utils/integrations/email/emailService.js";

const paymentRepo = () => AppDataSource.getRepository(Payment);
const userRepo = () => AppDataSource.getRepository(User);
const eventRepo = () => AppDataSource.getRepository(PaymentWebhookEvent);
const subscriptionRepo = () => AppDataSource.getRepository(Subscription);
const organizationRepo = () => AppDataSource.getRepository(Organization);
const planRepo = () => AppDataSource.getRepository(Plan);
const jobRepo = () => AppDataSource.getRepository(Job);

export const paymentRecords = async (userId: string): Promise<Payment[]> => {
  return paymentRepo().find({
    where: { userId },
    relations: { plan: true },
    order: { createdAt: "DESC" },
  });
};

const appendHistory = (
  payment: Payment,
  description: string
): Array<{ description: string; author: string; date: Date }> => [
  ...(payment.history ?? []),
  { description, author: payment.userId, date: new Date() },
];

const formatMoney = (amount: number, symbol: string): string => {
  const formatted = new Intl.NumberFormat("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${symbol}${formatted}`;
};

const resolvePlanRow = async (planKey: string, interval: BillingInterval): Promise<Plan> => {
  const row = await planRepo().findOne({ where: { planKey, interval, isDeleted: false } });
  if (!row) throw new NotFoundError(`Plan ${planKey}/${interval} is not available`);
  if (!isDummyPaystack() && !row.paystackPlanCode) {
    throw new ValidationError(`Plan ${planKey}/${interval} is not connected to Paystack`);
  }
  return row;
};

/** Only the organization owner manages billing — purchasing/changing/cancelling the company's plan. */
const resolveOrganizationForBilling = async (user: User): Promise<Organization> => {
  if (!user.activeOrganizationId) {
    throw new ValidationError("Join or create a company before purchasing a plan");
  }
  const organization = await organizationRepo().findOne({
    where: { id: user.activeOrganizationId },
  });
  if (!organization) {
    throw new NotFoundError("Organization not found");
  }
  if (organization.ownerId !== user.id) {
    throw new AuthorizationError("Only the organization owner can manage billing");
  }
  return organization;
};

const sendPaymentReceipt = async (payment: Payment): Promise<void> => {
  const user = await userRepo().findOne({ where: { id: payment.userId } });
  if (!user) return;

  const catalog = loadPricingCatalog();
  const planRecord = payment.planId
    ? await planRepo().findOne({ where: { id: payment.planId } })
    : null;
  const metadataPlanKey = (payment.initialConfig as { metadata?: { planKey?: string } } | null)
    ?.metadata?.planKey;
  const planName = planRecord?.name ?? getPlanByKey(metadataPlanKey ?? "")?.name ?? "Your plan";
  const interval = !payment.billingInterval
    ? "One-time"
    : payment.billingInterval === BillingInterval.Annually
      ? "Annually"
      : "Monthly";
  const paidAt = payment.paidAt ?? new Date();
  const origin = (env.website ?? "").replace(/\/$/, "");

  await new EmailService().sendPaymentConfirmation({
    email: user.email,
    firstName: user.firstName,
    planName,
    interval,
    amount: formatMoney(payment.amount, catalog.currencySymbol),
    currency: payment.currency,
    reference: payment.paystackRef ?? payment.reference ?? "",
    paidAt: paidAt.toLocaleString("en-NG", {
      dateStyle: "medium",
      timeStyle: "short",
    }),
    billingStatus: "Active",
    manageUrl: `${origin}/recruiterDashboard/plan`,
  });
};

/**
 * Completes a payment and applies its effect — either activating the specific job it was
 * for (Pay per Use, one-time per-job charge) or updating the organization's subscription
 * tier (every other plan). These are kept as two clearly separate branches rather than
 * one overloaded "apply billing" path, since they mean very different things.
 */
const fulfillPayment = async (payment: Payment, authorizationCode?: string): Promise<boolean> => {
  let newlyCompleted = false;
  const replacedSubscriptions: Subscription[] = [];
  await AppDataSource.manager.transaction(async (manager) => {
    const locked = await manager.findOne(Payment, {
      where: { id: payment.id },
      lock: { mode: "pessimistic_write" },
    });
    if (!locked) return;
    if (locked.status === PaymentStatus.Completed) return;

    locked.status = PaymentStatus.Completed;
    locked.paidAt = new Date();
    locked.history = appendHistory(locked, "Payment completed");
    if (authorizationCode) {
      locked.finalConfig = {
        ...(locked.finalConfig ?? {}),
        authorization_code: authorizationCode,
      };
    }
    await manager.save(locked);

    const metadata = (locked.initialConfig as { metadata?: Record<string, string> } | null)
      ?.metadata;
    const jobId = metadata?.jobId;

    if (jobId) {
      await manager.update(Job, { id: jobId }, { status: JobStatus.Active });
    } else if (locked.organizationId) {
      const plan = locked.planId
        ? await manager.findOne(Plan, { where: { id: locked.planId } })
        : null;
      // No resolvable plan means we cannot say what was bought — leave billing alone
      // rather than writing a placeholder tier that the catalogue does not gate.
      if (plan) {
        const paidAt = locked.paidAt ?? new Date();
        const interval = locked.billingInterval;
        const organization = await setOrganizationBilling(
          locked.organizationId,
          {
            billingPlan: plan.planKey,
            billingInterval: interval,
            billingStatus: BillingStatus.Active,
            billingPeriodEnd: computeBillingPeriodEnd(paidAt, interval),
          },
          { reason: PlanChangeReason.Purchase, paymentId: locked.id },
          manager
        );
        if (organization) {
          // Cancel other active subscriptions for this org without touching billing —
          // billing was just set to the new plan above.
          const otherSubs = await manager.find(Subscription, {
            where: {
              organizationId: organization.id,
              status: SubscriptionStatus.Active,
            },
          });
          for (const sub of otherSubs) {
            if (sub.planId === plan.id) continue;
            sub.status = SubscriptionStatus.Cancelled;
            sub.history = [
              ...(sub.history ?? []),
              {
                description: "Replaced by plan upgrade",
                author: locked.userId,
                date: new Date(),
              },
            ];
            await manager.save(sub);
            replacedSubscriptions.push(sub);
          }
        }
      }
    }

    newlyCompleted = true;
  });

  if (newlyCompleted) {
    await disableReplacedSubscriptions(replacedSubscriptions);
  }
  return newlyCompleted;
};

/**
 * Stops Paystack from charging for subscriptions an upgrade replaced. Best effort: the upgrade
 * has already committed, so a Paystack failure is logged for follow-up rather than surfaced.
 */
const disableReplacedSubscriptions = async (subscriptions: Subscription[]): Promise<void> => {
  for (const sub of subscriptions) {
    if (!sub.paystackSubscriptionCode) continue;
    try {
      const response = await paystackDisableSubscription({
        code: sub.paystackSubscriptionCode,
        token: sub.email_token ?? "",
      });
      if (!response.status) {
        logger.error(
          `Paystack refused to disable replaced subscription ${sub.id}: ${response.message}`
        );
      }
    } catch (err) {
      logger.error(
        `Failed to disable replaced subscription ${sub.id} on Paystack: ${(err as Error).message}`
      );
    }
  }
};

const markFailed = async (payment: Payment, reason: string): Promise<void> => {
  await AppDataSource.manager.transaction(async (manager) => {
    const locked = await manager.findOne(Payment, {
      where: { id: payment.id },
      lock: { mode: "pessimistic_write" },
    });
    if (!locked) return;
    if (locked.status === PaymentStatus.Completed) return;
    locked.status = PaymentStatus.Failed;
    locked.history = appendHistory(locked, reason);
    await manager.save(locked);
  });
};

/**
 * Extends an organization's paid window when Paystack renews a subscription. Month 2+
 * charges arrive under a Paystack-generated reference we never stored, so without this the
 * paid period is never moved and the lazy expiry check downgrades a paying customer.
 *
 * Idempotent and monotonic: renewal webhooks are retried and can arrive out of order, so
 * every date only ever moves forward. Returns the organization id when it was extended.
 */
const applySubscriptionRenewal = async (
  subscriptionCode: string,
  nextPaymentDate: Date | null
): Promise<string | null> => {
  const found = await subscriptionRepo().findOne({
    where: { paystackSubscriptionCode: subscriptionCode },
  });
  if (!found) return null;

  const plan = await planRepo().findOne({ where: { id: found.planId } });
  const periodEnd =
    nextPaymentDate ??
    computeBillingPeriodEnd(new Date(), plan?.interval ?? BillingInterval.Monthly);

  let extendedOrganizationId: string | null = null;

  await AppDataSource.manager.transaction(async (manager) => {
    // Organization first, then subscription — fulfillPayment takes the same order, and the
    // reverse here would deadlock a renewal against a concurrent upgrade for the same org.
    const organization = await manager.findOne(Organization, {
      where: { id: found.organizationId },
      lock: { mode: "pessimistic_write" },
    });
    if (!organization) return;

    const locked = await manager.findOne(Subscription, {
      where: { id: found.id },
      lock: { mode: "pessimistic_write" },
    });
    if (!locked) return;
    // A subscription an upgrade already cancelled must not be resurrected by a late webhook.
    if (locked.status === SubscriptionStatus.Cancelled) return;

    const forward = (current: Date | null): Date =>
      current && current.getTime() > periodEnd.getTime() ? current : periodEnd;

    locked.status = SubscriptionStatus.Active;
    locked.nextPaymentDate = forward(locked.nextPaymentDate);
    locked.expiryDate = forward(locked.expiryDate);
    locked.history = [
      ...(locked.history ?? []),
      {
        description: `Renewed until ${periodEnd.toISOString()}`,
        author: locked.userId,
        date: new Date(),
      },
    ];
    await manager.save(locked);

    // A newer upgrade must not be clobbered by a late renewal for the plan it replaced.
    if (plan && organization.billingPlan !== plan.planKey) return;

    await setOrganizationBilling(
      organization.id,
      {
        billingPlan: plan?.planKey ?? organization.billingPlan,
        billingInterval: plan?.interval ?? organization.billingInterval,
        billingStatus: BillingStatus.Active,
        billingPeriodEnd: forward(organization.billingPeriodEnd),
      },
      { reason: PlanChangeReason.Purchase },
      manager
    );
    extendedOrganizationId = organization.id;
  });

  return extendedOrganizationId;
};

const paidJobId = (payment: Payment): string | null =>
  (payment.initialConfig as { metadata?: { jobId?: string } } | null)?.metadata?.jobId ?? null;

export const verify = async (
  user: User,
  payload: { reference: string }
): Promise<{ jobId: string | null }> => {
  const payment = await paymentRepo().findOne({
    where: [{ paystackRef: payload.reference }, { reference: payload.reference }],
  });
  if (!payment) {
    throw new NotFoundError("Payment not found for reference");
  }
  if (payment.userId !== user.id) {
    throw new AuthorizationError("You cannot verify this payment");
  }
  if (payment.status === PaymentStatus.Completed) {
    return { jobId: paidJobId(payment) };
  }

  const response = await verifyTransaction(payment.paystackRef ?? payment.reference ?? "");
  if (!response?.status) {
    throw new ValidationError("Unable to verify payment");
  }

  const chargedKobo = response.data.amount;
  const currency = response.data.currency;
  const status = response.data.status;

  if (status === "success") {
    if (!isDummyPaystack()) {
      if (currency !== payment.currency) {
        throw new ValidationError("Payment currency does not match");
      }
      if (chargedKobo !== payment.amountKobo) {
        throw new ValidationError("Payment amount does not match");
      }
    }
    const newlyCompleted = await fulfillPayment(
      payment,
      response.data.authorization?.authorization_code
    );
    if (newlyCompleted) {
      const completed = await paymentRepo().findOne({ where: { id: payment.id } });
      if (completed) await sendPaymentReceipt(completed);
    }
    return { jobId: paidJobId(payment) };
  }

  if (status === "failed" || status === "abandoned") {
    await markFailed(payment, "Payment failed");
    throw new ValidationError("Payment failed");
  }

  throw new ValidationError("Payment is not yet complete");
};

const recordWebhookEvent = async (
  eventKey: string,
  event: string,
  reference: string | null
): Promise<boolean> => {
  try {
    await eventRepo().save(eventRepo().create({ eventKey, event, reference }));
    return true;
  } catch (error) {
    if (error instanceof QueryFailedError) {
      const driver = error.driverError as { code?: string };
      if (driver.code === "23505") return false;
    }
    throw error;
  }
};

const findPaymentByReference = async (reference: string): Promise<Payment | null> => {
  return paymentRepo().findOne({
    where: [{ paystackRef: reference }, { reference }],
  });
};

const subscriptionCodeOf = (data: Record<string, unknown>): string | undefined =>
  (data.subscription as Record<string, string> | undefined)?.subscription_code ??
  (data.subscription_code as string | undefined);

export const paystackWebhook = async (payload: {
  event: string;
  data: Record<string, unknown>;
}): Promise<void> => {
  const { event, data } = payload;
  const reference = (data.reference as string | undefined) ?? null;
  const paystackId = data.id != null ? String(data.id) : "";
  // Invoice events carry no top-level reference and nest the subscription code, so the key
  // has to reach for those too — otherwise every renewal collapses onto one key and the
  // already-processed check silently drops all of them.
  const eventKey = [
    event,
    reference ?? (data.invoice_code as string | undefined) ?? subscriptionCodeOf(data) ?? "none",
    paystackId,
    (data.period_end as string | undefined) ?? "",
  ].join(":");

  const alreadyProcessed = await eventRepo().findOne({ where: { eventKey } });
  if (alreadyProcessed) return;

  const finish = async () => {
    await recordWebhookEvent(eventKey, event, reference);
  };

  if (event === "charge.success" && data.status === "success") {
    if (!reference) {
      await finish();
      return;
    }
    const payment = await findPaymentByReference(reference);
    if (!payment) {
      await finish();
      return;
    }

    if (!isDummyPaystack()) {
      const chargedKobo = Number(data.amount);
      const currency = data.currency as string | undefined;
      if (currency && currency !== payment.currency) {
        await finish();
        return;
      }
      if (Number.isFinite(chargedKobo) && chargedKobo !== payment.amountKobo) {
        await finish();
        return;
      }
    }

    const authorizationCode =
      (data.authorization as Record<string, string> | undefined)?.authorization_code ?? undefined;
    const newlyCompleted = await fulfillPayment(payment, authorizationCode);
    if (newlyCompleted) {
      const completed = await paymentRepo().findOne({ where: { id: payment.id } });
      if (completed) await sendPaymentReceipt(completed);
    }
    await finish();
    return;
  }

  if (event === "charge.failed" || event === "charge.abandoned") {
    if (reference) {
      const payment = await findPaymentByReference(reference);
      if (payment) await markFailed(payment, `Paystack ${event}`);
    }
    await finish();
    return;
  }

  // Recurring renewals (month 2+). Paystack fires invoice.create (unpaid) -> charge.success
  // (under a reference we never stored) -> invoice.update (settled, carrying the new
  // next_payment_date). invoice.update is the only event that both names the subscription
  // and carries the new period, so it is the authoritative extender and invoice.create is
  // deliberately a no-op until the invoice is actually paid.
  if (event === "invoice.create" || event === "invoice.update") {
    const subscriptionCode = subscriptionCodeOf(data);
    const settled = data.paid === true || data.status === "success";
    if (subscriptionCode && settled) {
      const subscription = data.subscription as Record<string, unknown> | undefined;
      const next =
        (subscription?.next_payment_date as string | undefined) ??
        (data.period_end as string | undefined);
      const renewedOrganizationId = await applySubscriptionRenewal(
        subscriptionCode,
        next ? new Date(next) : null
      );
      if (renewedOrganizationId) await resetPeriodUsage(renewedOrganizationId);
    }
    await finish();
    return;
  }

  if (event === "invoice.payment_failed") {
    const subscriptionCode = subscriptionCodeOf(data);
    if (subscriptionCode) {
      const subscription = await subscriptionRepo().findOne({
        where: { paystackSubscriptionCode: subscriptionCode },
      });
      if (subscription) {
        await setOrganizationBillingStatus(subscription.organizationId, BillingStatus.PastDue);
      }
    }
    await finish();
    return;
  }

  if (event === "subscription.disable") {
    const code = data.subscription_code as string | undefined;
    if (code) {
      const subscription = await subscriptionRepo().findOne({
        where: { paystackSubscriptionCode: code },
        relations: { plan: true },
      });
      if (subscription) {
        await subscriptionRepo().save({
          ...subscription,
          status: SubscriptionStatus.Cancelled,
          history: [
            ...(subscription.history ?? []),
            {
              description: "Subscription disabled",
              author: subscription.userId,
              date: new Date(),
            },
          ],
        });
        // Revert immediately, but only while this sub still matches the org's plan — an
        // upgrade that disabled the old sub after writing the new plan must survive. The
        // check and the write are one statement, so the race cannot be lost.
        const disabledPlanKey = subscription.plan?.planKey;
        if (disabledPlanKey) {
          await revertToPayPerUseIfStillOnPlan(subscription.organizationId, disabledPlanKey);
        }
      }
    }
    await finish();
    return;
  }

  if (event === "subscription.enable" || event === "subscription.create") {
    const code = data.subscription_code as string | undefined;
    const planData = data.plan as Record<string, unknown> | string | undefined;
    const planCode =
      typeof planData === "string"
        ? planData
        : ((planData as Record<string, string> | undefined)?.plan_code ?? undefined);

    if (code) {
      const existing = await subscriptionRepo().findOne({
        where: { paystackSubscriptionCode: code },
      });
      if (existing) {
        const plan = await planRepo().findOne({ where: { id: existing.planId } });
        const periodEnd = data.next_payment_date
          ? new Date(data.next_payment_date as string)
          : computeBillingPeriodEnd(new Date(), plan?.interval ?? BillingInterval.Monthly);
        await subscriptionRepo().save({
          ...existing,
          status: SubscriptionStatus.Active,
          email_token: (data.email_token as string) ?? existing.email_token,
          nextPaymentDate: periodEnd,
          expiryDate: periodEnd,
        });
        // A late enable for a subscription an upgrade has since replaced must not take the
        // newer plan away.
        const superseded = await subscriptionRepo()
          .createQueryBuilder("s")
          .where("s.organizationId = :organizationId", {
            organizationId: existing.organizationId,
          })
          .andWhere("s.status = :active", { active: SubscriptionStatus.Active })
          .andWhere("s.id <> :subscriptionId", { subscriptionId: existing.id })
          .andWhere(
            `s.createdAt > (SELECT "createdAt" FROM "subscriptions" WHERE "id" = :subscriptionId)`
          )
          .getExists();
        if (plan && !superseded) {
          await setOrganizationBilling(
            existing.organizationId,
            {
              billingPlan: plan.planKey,
              billingInterval: plan.interval,
              billingStatus: BillingStatus.Active,
              billingPeriodEnd: periodEnd,
            },
            { reason: PlanChangeReason.SubscriptionEnabled }
          );
        }
      } else {
        const customerData = data.customer as Record<string, string> | undefined;
        const user = customerData?.email
          ? await userRepo().findOne({ where: { email: customerData.email } })
          : null;
        const plan = planCode
          ? await planRepo().findOne({ where: { paystackPlanCode: planCode } })
          : null;

        if (user?.activeOrganizationId && plan) {
          const subscription = subscriptionRepo().create({
            userId: user.id,
            organizationId: user.activeOrganizationId,
            planId: plan.id,
            paystackSubscriptionCode: code,
            email_token: (data.email_token as string) ?? null,
            status: SubscriptionStatus.Active,
            startDate: new Date(),
            nextPaymentDate: data.next_payment_date
              ? new Date(data.next_payment_date as string)
              : null,
            expiryDate: data.next_payment_date
              ? new Date(data.next_payment_date as string)
              : computeBillingPeriodEnd(new Date(), plan.interval),
          });
          await subscriptionRepo().save(subscription);
          await setOrganizationBilling(
            user.activeOrganizationId,
            {
              billingPlan: plan.planKey,
              billingInterval: plan.interval,
              billingStatus: BillingStatus.Active,
              billingPeriodEnd:
                subscription.expiryDate ?? computeBillingPeriodEnd(new Date(), plan.interval),
            },
            { reason: PlanChangeReason.SubscriptionEnabled }
          );
        }
      }
    }
    await finish();
    return;
  }

  await finish();
};

export const initiateTransaction = async (
  user: User,
  payload: { planKey?: string; interval?: BillingInterval }
): Promise<{ link: string; reference: string; mode: string }> => {
  if (!payload.planKey || !getSubscriptionPlanKeys().includes(payload.planKey)) {
    throw new ValidationError("Unknown or non-subscription plan");
  }
  const planKey = payload.planKey;

  const organization = await resolveOrganizationForBilling(user);

  const interval =
    payload.interval === BillingInterval.Annually
      ? BillingInterval.Annually
      : BillingInterval.Monthly;
  const planRow = await resolvePlanRow(planKey, interval);

  // Do not disable the existing subscription before payment completes — that
  // caused a race where subscription.disable briefly reset the org to free/PPU
  // while checkout was still pending. Old subs are cancelled inside fulfillPayment
  // after the new plan is written. Still reject identical-plan re-purchases.
  const existingSubscription = await subscriptionRepo().findOne({
    where: { organizationId: organization.id, status: SubscriptionStatus.Active },
  });
  if (existingSubscription && existingSubscription.planId === planRow.id) {
    throw new ConflictError("Your company is already on this plan");
  }

  const amountKobo = Math.round(planRow.paystackAmount);

  const reference = await generateReference(async (ref) => {
    const existing = await paymentRepo().findOne({ where: { reference: ref } });
    return !!existing;
  });

  await createCustomer({ email: user.email });

  const initialConfig = generatePaymentObject(amountKobo, user.email, {
    reference,
    planCode: isDummyPaystack() ? undefined : (planRow.paystackPlanCode ?? undefined),
    metadata: {
      userId: user.id,
      organizationId: organization.id,
      planKey,
      interval,
    },
  });

  const paymentResponse = await initializePayment(initialConfig);
  const paystackRef = paymentResponse.data.reference;

  await paymentRepo().save(
    paymentRepo().create({
      amount: amountKobo / 100,
      amountKobo,
      currency: initialConfig.currency,
      paymentLink: paymentResponse.data.authorization_url,
      reference,
      paystackRef,
      billingInterval: interval,
      userId: user.id,
      organizationId: organization.id,
      planId: planRow.id,
      status: PaymentStatus.Pending,
      initialConfig: initialConfig as unknown as Record<string, unknown>,
    })
  );

  return {
    link: paymentResponse.data.authorization_url,
    reference: paystackRef,
    mode: isDummyPaystack() ? "dummy" : "paystack",
  };
};

/**
 * Pay per Use has no Paystack subscription plan — every job posting is a fresh one-time
 * charge, initiated from the job-posting flow rather than the pricing page. Any recruiter
 * at the org can trigger this (unlike initiateTransaction, this isn't a billing-management
 * action — posting jobs is normal recruiter work).
 */
export const initiateJobPayment = async (
  user: User,
  jobId: string
): Promise<{ link: string; reference: string; mode: string }> => {
  const job = await jobRepo().findOne({ where: { id: jobId } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (!job.organizationId) {
    throw new ValidationError("Job has no organization");
  }
  if (job.status === JobStatus.Active) {
    throw new ConflictError("This job is already active");
  }
  if (job.status !== JobStatus.Draft && job.status !== JobStatus.PendingPayment) {
    throw new ValidationError("Only draft jobs can be paid for");
  }
  if (user.activeOrganizationId !== job.organizationId) {
    throw new AuthorizationError("You are not authorized to pay for this job");
  }
  if (!job.aiConfigId) {
    throw new ValidationError("This job cannot be activated until an AI configuration is added");
  }

  const stored = await organizationRepo().findOne({ where: { id: job.organizationId } });
  if (!stored) {
    throw new NotFoundError("Organization not found");
  }
  // An org whose paid period lapsed is still on the old plan in the DB until some read path
  // notices, which would reject per-job checkout for a company that is back on pay per use.
  const organization = await ensureOrganizationBillingCurrent(stored);
  if (organization.billingPlan !== DEFAULT_BILLING_PLAN_KEY) {
    throw new ValidationError("This job's organization is not on the Pay per Use plan");
  }

  const plan = getPlanByKey(DEFAULT_BILLING_PLAN_KEY);
  if (!plan) {
    throw new NotFoundError("Pay per Use plan not found in catalogue");
  }
  const amountKobo = ngnToKobo(plan.monthlyAmountNgn);

  const reference = await generateReference(async (ref) => {
    const existing = await paymentRepo().findOne({ where: { reference: ref } });
    return !!existing;
  });

  await createCustomer({ email: user.email });

  const initialConfig = generatePaymentObject(amountKobo, user.email, {
    reference,
    metadata: {
      userId: user.id,
      organizationId: organization.id,
      jobId: job.id,
      planKey: DEFAULT_BILLING_PLAN_KEY,
    },
  });

  const paymentResponse = await initializePayment(initialConfig);
  const paystackRef = paymentResponse.data.reference;

  await paymentRepo().save(
    paymentRepo().create({
      amount: amountKobo / 100,
      amountKobo,
      currency: initialConfig.currency,
      paymentLink: paymentResponse.data.authorization_url,
      reference,
      paystackRef,
      billingInterval: null,
      userId: user.id,
      organizationId: organization.id,
      planId: null,
      status: PaymentStatus.Pending,
      initialConfig: initialConfig as unknown as Record<string, unknown>,
    })
  );

  return {
    link: paymentResponse.data.authorization_url,
    reference: paystackRef,
    mode: isDummyPaystack() ? "dummy" : "paystack",
  };
};
