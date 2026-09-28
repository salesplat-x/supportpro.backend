/**
 * Entitlements/gating tests — services/entitlements.ts.
 *
 * Covers the plan-limit enforcement that every metered feature (job_listings,
 * candidate_views, team_members) and flag feature (bulk_broadcast_tools, hr_assistant, …)
 * relies on. Exercises the happy path plus the edge cases and loopholes in how a plan's
 * limits get resolved and enforced.
 */

import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { createRecruiter, createOrganization } from "./helpers/fixtures.js";
import {
  assertWithinLimit,
  getOrganizationUsage,
  hasFlag,
  recordUsage,
  getPlanFeature,
} from "../src/services/entitlements.js";
import { PlanLimitError } from "../src/utils/errors/PlanLimitError.js";
import { FeatureUsageCounter } from "../src/entities/FeatureUsageCounter.js";
import { Organization } from "../src/entities/Organization.js";
import { DEFAULT_BILLING_PLAN_KEY } from "../src/types/enums.js";

beforeAll(async () => {
  await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await clearAllTables();
});

async function orgOnPlan(billingPlan: string): Promise<Organization> {
  const { user } = await createRecruiter();
  return createOrganization(user, { billingPlan });
}

// Mirrors entitlements.ts's private currentPeriodStart() — first of the current UTC month.
function currentPeriodStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

describe("getPlanFeature", () => {
  it("finds a feature declared on the org's plan", async () => {
    const org = await orgOnPlan("sme_basic");
    expect(getPlanFeature(org, "job_listings")?.limit).toBe(2);
  });

  it("returns undefined for a feature the plan doesn't declare", async () => {
    const org = await orgOnPlan("sme_basic");
    expect(getPlanFeature(org, "hr_assistant")).toBeUndefined();
  });

  it("returns undefined for an entirely unknown plan key", async () => {
    const org = await orgOnPlan("this_plan_does_not_exist");
    expect(getPlanFeature(org, "job_listings")).toBeUndefined();
  });
});

describe("hasFlag", () => {
  it("true for an included flag feature", async () => {
    const org = await orgOnPlan("pro");
    expect(hasFlag(org, "bulk_broadcast_tools")).toBe(true);
  });

  it("false when the plan doesn't have the flag at all", async () => {
    const org = await orgOnPlan("sme_basic");
    expect(hasFlag(org, "bulk_broadcast_tools")).toBe(false);
  });

  it("false for a metered feature key (wrong kind)", async () => {
    const org = await orgOnPlan("pro");
    expect(hasFlag(org, "job_listings")).toBe(false);
  });

  it("false for an unknown feature key", async () => {
    const org = await orgOnPlan("pro");
    expect(hasFlag(org, "not_a_real_feature")).toBe(false);
  });
});

// "Everything in Pro, plus" must hold for gating, not just for the pricing page copy.
describe("plan inheritance", () => {
  it.each(["advance", "enterprise"])("%s includes Pro's bulk tools", async (plan) => {
    const org = await orgOnPlan(plan);
    expect(hasFlag(org, "bulk_broadcast_tools")).toBe(true);
  });

  it("enterprise includes Advance's flags as well as its own", async () => {
    const org = await orgOnPlan("enterprise");
    expect(hasFlag(org, "job_board_distribution")).toBe(true);
    expect(hasFlag(org, "dedicated_support")).toBe(true);
    expect(hasFlag(org, "hr_assistant")).toBe(true);
  });

  it("a plan's own limit wins over the one it inherits", async () => {
    const org = await orgOnPlan("advance");
    expect(getPlanFeature(org, "job_listings")?.limit).toBe(30);
    expect(getPlanFeature(org, "candidate_views")?.limit).toBeNull();
  });

  it("inheritance only flows upward — Pro does not get Advance's or Enterprise's flags", async () => {
    const org = await orgOnPlan("pro");
    expect(hasFlag(org, "job_board_distribution")).toBe(false);
    expect(hasFlag(org, "hr_assistant")).toBe(false);
  });

  it("the usage snapshot lists inherited flags once", async () => {
    const org = await orgOnPlan("enterprise");
    const usage = await getOrganizationUsage(org.id);
    const keys = usage.flags.map((flag) => flag.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "bulk_broadcast_tools",
        "job_board_distribution",
        "dedicated_support",
        "hr_assistant",
      ])
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(usage.meters.map((meter) => meter.key)).toEqual([
      "job_listings",
      "candidate_views",
      "team_members",
    ]);
  });
});

describe("assertWithinLimit — monthly metered features", () => {
  it("resolves when usage is under the limit", async () => {
    const org = await orgOnPlan("sme_basic"); // candidate_views limit 50
    await testDataSource.getRepository(FeatureUsageCounter).save({
      organizationId: org.id,
      featureKey: "candidate_views",
      periodStart: currentPeriodStart(),
      count: 10,
    });
    await expect(assertWithinLimit(org, "candidate_views")).resolves.toBeUndefined();
  });

  it("throws PlanLimitError once usage is at the limit", async () => {
    const org = await orgOnPlan("sme_basic"); // candidate_views limit 50
    await testDataSource.getRepository(FeatureUsageCounter).save({
      organizationId: org.id,
      featureKey: "candidate_views",
      periodStart: currentPeriodStart(),
      count: 50,
    });
    await expect(assertWithinLimit(org, "candidate_views")).rejects.toBeInstanceOf(PlanLimitError);
  });

  it("PlanLimitError carries the featureKey and planKey for the client to act on", async () => {
    const org = await orgOnPlan("sme_basic");
    await testDataSource.getRepository(FeatureUsageCounter).save({
      organizationId: org.id,
      featureKey: "candidate_views",
      periodStart: currentPeriodStart(),
      count: 999,
    });
    try {
      await assertWithinLimit(org, "candidate_views");
      throw new Error("expected assertWithinLimit to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanLimitError);
      expect((err as PlanLimitError).featureKey).toBe("candidate_views");
      expect((err as PlanLimitError).planKey).toBe("sme_basic");
      expect((err as PlanLimitError).statusCode).toBe(402);
    }
  });

  it("never throws when the plan's limit is null (unlimited)", async () => {
    const org = await orgOnPlan("advance"); // candidate_views: limit null on Advance
    await testDataSource.getRepository(FeatureUsageCounter).save({
      organizationId: org.id,
      featureKey: "candidate_views",
      periodStart: currentPeriodStart(),
      count: 1_000_000,
    });
    await expect(assertWithinLimit(org, "candidate_views")).resolves.toBeUndefined();
  });

  it("no counter row yet → treated as zero usage, resolves", async () => {
    const org = await orgOnPlan("sme_basic");
    await expect(assertWithinLimit(org, "candidate_views")).resolves.toBeUndefined();
  });
});

describe("assertWithinLimit — concurrent metered features", () => {
  it("resolves when the live count is under the limit", async () => {
    const org = await orgOnPlan("sme_basic"); // job_listings limit 2
    await expect(assertWithinLimit(org, "job_listings", async () => 1)).resolves.toBeUndefined();
  });

  it("throws once the live count is at the limit", async () => {
    const org = await orgOnPlan("sme_basic");
    await expect(assertWithinLimit(org, "job_listings", async () => 2)).rejects.toBeInstanceOf(
      PlanLimitError
    );
  });

  it("throws when the live count is somehow already over the limit", async () => {
    const org = await orgOnPlan("sme_basic");
    await expect(assertWithinLimit(org, "job_listings", async () => 5)).rejects.toBeInstanceOf(
      PlanLimitError
    );
  });

  it("programmer error: missing currentConcurrentCount callback throws a plain Error, not a PlanLimitError", async () => {
    const org = await orgOnPlan("sme_basic");
    await expect(assertWithinLimit(org, "job_listings")).rejects.toThrow(
      /requires currentConcurrentCount/
    );
    await expect(assertWithinLimit(org, "job_listings")).rejects.not.toBeInstanceOf(PlanLimitError);
  });
});

describe("assertWithinLimit — non-metered / unknown inputs are no-ops", () => {
  it("no-ops for a flag-kind feature key", async () => {
    const org = await orgOnPlan("pro");
    await expect(assertWithinLimit(org, "bulk_broadcast_tools")).resolves.toBeUndefined();
  });

  it("no-ops for a feature key the plan doesn't declare at all", async () => {
    const org = await orgOnPlan("sme_basic");
    await expect(assertWithinLimit(org, "totally_made_up_feature")).resolves.toBeUndefined();
  });

  // The default plan is a real catalogue entry, so a brand-new org is gated rather than
  // silently unlimited the way the old "free" default was.
  it("orgs on the default pay_per_use plan are gated by the catalogue", async () => {
    const org = await orgOnPlan(DEFAULT_BILLING_PLAN_KEY);
    await expect(assertWithinLimit(org, "candidate_views")).resolves.toBeUndefined();
    await expect(assertWithinLimit(org, "team_members", async () => 999)).rejects.toThrow(
      PlanLimitError
    );
  });

  // Same class of loophole: any garbage billingPlan value (a typo, a stale/removed plan
  // key, direct DB tampering) resolves to "no matching catalogue plan" and therefore
  // "no gating at all", rather than failing closed.
  it("LOOPHOLE: an unrecognized/garbage billingPlan value is also never limited", async () => {
    const org = await orgOnPlan("not_a_real_plan_key");
    await expect(assertWithinLimit(org, "job_listings", async () => 999)).resolves.toBeUndefined();
  });
});

describe("recordUsage", () => {
  it("increments the monthly counter by 1 by default", async () => {
    const org = await orgOnPlan("sme_basic");
    await recordUsage(org, "candidate_views");
    const counter = await testDataSource
      .getRepository(FeatureUsageCounter)
      .findOne({ where: { organizationId: org.id, featureKey: "candidate_views" } });
    expect(counter?.count).toBe(1);
  });

  it("increments by the given amount and accumulates across calls", async () => {
    const org = await orgOnPlan("sme_basic");
    await recordUsage(org, "candidate_views", 5);
    await recordUsage(org, "candidate_views", 3);
    const counter = await testDataSource
      .getRepository(FeatureUsageCounter)
      .findOne({ where: { organizationId: org.id, featureKey: "candidate_views" } });
    expect(counter?.count).toBe(8);
  });

  it("no-ops for concurrent-period features (job_listings is derived live, never counted)", async () => {
    const org = await orgOnPlan("sme_basic");
    await recordUsage(org, "job_listings");
    const counter = await testDataSource
      .getRepository(FeatureUsageCounter)
      .findOne({ where: { organizationId: org.id, featureKey: "job_listings" } });
    expect(counter).toBeNull();
  });

  it("no-ops for flag features", async () => {
    const org = await orgOnPlan("pro");
    await recordUsage(org, "bulk_broadcast_tools");
    const counter = await testDataSource
      .getRepository(FeatureUsageCounter)
      .findOne({ where: { organizationId: org.id, featureKey: "bulk_broadcast_tools" } });
    expect(counter).toBeNull();
  });

  it("no-ops for orgs on an unknown plan (nothing to meter)", async () => {
    const org = await orgOnPlan("not_a_real_plan_key");
    await recordUsage(org, "candidate_views");
    const counter = await testDataSource
      .getRepository(FeatureUsageCounter)
      .findOne({ where: { organizationId: org.id, featureKey: "candidate_views" } });
    expect(counter).toBeNull();
  });

  it("rolls over into a fresh counter for a new calendar month rather than reusing last month's", async () => {
    const org = await orgOnPlan("sme_basic");
    const lastMonth = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)
    )
      .toISOString()
      .slice(0, 10);
    await testDataSource.getRepository(FeatureUsageCounter).save({
      organizationId: org.id,
      featureKey: "candidate_views",
      periodStart: lastMonth,
      count: 999,
    });

    await recordUsage(org, "candidate_views");

    const rows = await testDataSource
      .getRepository(FeatureUsageCounter)
      .find({ where: { organizationId: org.id, featureKey: "candidate_views" } });
    expect(rows).toHaveLength(2);
    const currentPeriodStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)
    )
      .toISOString()
      .slice(0, 10);
    const current = rows.find((r) => r.periodStart === currentPeriodStart);
    expect(current?.count).toBe(1);
    const stale = rows.find((r) => r.periodStart === lastMonth);
    expect(stale?.count).toBe(999);
  });

  it("last month's usage doesn't count against this month's limit (rollover resets access, not just the counter)", async () => {
    const org = await orgOnPlan("sme_basic"); // candidate_views limit 50
    const lastMonth = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)
    )
      .toISOString()
      .slice(0, 10);
    await testDataSource.getRepository(FeatureUsageCounter).save({
      organizationId: org.id,
      featureKey: "candidate_views",
      periodStart: lastMonth,
      count: 50, // maxed out last month
    });
    await expect(assertWithinLimit(org, "candidate_views")).resolves.toBeUndefined();
  });
});
