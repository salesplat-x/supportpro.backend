import { MigrationInterface, QueryRunner } from "typeorm";

export class OrgScopedBilling1788400000000 implements MigrationInterface {
  name = "OrgScopedBilling1788400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Billing moves from User to Organization: a plan is purchased for the
    // whole company and shared by every recruiter who's a member. ---
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "billing_plan" character varying(64) NOT NULL DEFAULT 'free'`
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "billing_interval" "public"."plans_interval_enum"`
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "billing_status" "public"."users_billingstatus_enum" NOT NULL DEFAULT 'active'`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_organizations_billing_plan" ON "organizations" ("billing_plan")`
    );

    // Backfill: each organization inherits its current owner's legacy billing state.
    // Intentionally NOT remapped to a new tier key (e.g. 'paid' stays 'paid') — see
    // PRICING_PLAN.md for why grandfathering matters here (a live Paystack subscription
    // still charges the old amount; the UI must keep matching it).
    await queryRunner.query(`
      UPDATE "organizations" o
      SET "billing_plan" = u."billingPlan", "billing_interval" = u."billingInterval", "billing_status" = u."billingStatus"
      FROM "users" u
      WHERE o."owner_id" = u.id AND u."billingPlan" <> 'free'
    `);

    // --- Subscriptions/payments now link to the organization they actually belong
    // to (the entitlement key), not just the user who happened to pay. ---
    await queryRunner.query(
      `ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "organization_id" uuid`
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "organization_id" uuid`
    );
    // Best-effort backfill from the paying user's current active org — there is no
    // historical link for past rows, so this is an approximation for pre-existing data.
    await queryRunner.query(`
      UPDATE "subscriptions" s SET "organization_id" = u."active_organization_id"
      FROM "users" u WHERE s."user_id" = u.id AND s."organization_id" IS NULL
    `);
    await queryRunner.query(`
      UPDATE "payments" p SET "organization_id" = u."active_organization_id"
      FROM "users" u WHERE p."user_id" = u.id AND p."organization_id" IS NULL
    `);
    // Every subscription is created through the new org-scoped checkout flow going forward;
    // the live `subscriptions` table is empty pre-rewrite (see PRICING_PLAN.md), so this is safe.
    await queryRunner.query(`ALTER TABLE "subscriptions" ALTER COLUMN "organization_id" SET NOT NULL`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_subscriptions_organization_id" ON "subscriptions" ("organization_id")`
    );
    await queryRunner.query(`
      ALTER TABLE "payments" ADD CONSTRAINT "FK_fc07ace491143726974991711f2"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "subscriptions" ADD CONSTRAINT "FK_9ea1509175fa294fc64d43a9fe6"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
    `);

    // --- Drop billing columns from users — no longer a per-user concept. ---
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "billingPlan"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "billingInterval"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "billingStatus"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_billing_plan"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."users_billingplan_enum"`);

    // --- Plan gets a stable slug linking it back to config/pricing.yaml. ---
    await queryRunner.query(`ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "plan_key" character varying(64)`);
    await queryRunner.query(`UPDATE "plans" SET "plan_key" = 'paid' WHERE "plan_key" IS NULL`);
    await queryRunner.query(`ALTER TABLE "plans" ALTER COLUMN "plan_key" SET NOT NULL`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_plans_key_interval" ON "plans" ("plan_key","interval") WHERE "isDeleted" = false
    `);

    // --- Usage tracking for monthly-reset gated features (candidate_views), shared per organization. ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "feature_usage_counters" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "feature_key" character varying(64) NOT NULL,
        "period_start" date NOT NULL,
        "count" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_feature_usage_counters" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_feature_usage_counters_org_feature_period"
      ON "feature_usage_counters" ("organization_id", "feature_key", "period_start")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Lossy: recreating per-user billing from per-org billing loses "which member"
    // granularity — every member of a paid org's owner account would come back 'free'
    // except the owner. Acceptable for a rollback path, not a true inverse.
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_feature_usage_counters_org_feature_period"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "feature_usage_counters"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_plans_key_interval"`);
    await queryRunner.query(`ALTER TABLE "plans" DROP COLUMN IF EXISTS "plan_key"`);

    await queryRunner.query(
      `ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "FK_9ea1509175fa294fc64d43a9fe6"`
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "FK_fc07ace491143726974991711f2"`
    );

    await queryRunner.query(
      `CREATE TYPE "public"."users_billingplan_enum" AS ENUM('free', 'paid')`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "billingPlan" "public"."users_billingplan_enum" NOT NULL DEFAULT 'free'`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "billingInterval" "public"."plans_interval_enum"`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "billingStatus" "public"."users_billingstatus_enum" NOT NULL DEFAULT 'active'`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_billing_plan" ON "users" ("billingPlan")`
    );
    // Coerce any non-free/paid slug to 'paid' since the recreated enum can't hold arbitrary slugs.
    await queryRunner.query(`
      UPDATE "users" u SET "billingPlan" = CASE WHEN o."billing_plan" = 'free' THEN 'free' ELSE 'paid' END,
        "billingInterval" = o."billing_interval", "billingStatus" = o."billing_status"
      FROM "organizations" o WHERE o."owner_id" = u.id
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_subscriptions_organization_id"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "organization_id"`);
    await queryRunner.query(`ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "organization_id"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_organizations_billing_plan"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN IF EXISTS "billing_status"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN IF EXISTS "billing_interval"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN IF EXISTS "billing_plan"`);
  }
}
