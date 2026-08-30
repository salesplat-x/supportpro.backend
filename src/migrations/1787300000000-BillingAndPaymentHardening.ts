import { MigrationInterface, QueryRunner } from "typeorm";

export class BillingAndPaymentHardening1787300000000 implements MigrationInterface {
  name = "BillingAndPaymentHardening1787300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."users_billingplan_enum" AS ENUM('free', 'paid')`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_billingstatus_enum" AS ENUM('active', 'past_due', 'cancelled')`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "billingPlan" "public"."users_billingplan_enum" NOT NULL DEFAULT 'free'`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "billingInterval" "public"."plans_interval_enum" DEFAULT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "billingStatus" "public"."users_billingstatus_enum" NOT NULL DEFAULT 'active'`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_billing_plan" ON "users" ("billingPlan")`
    );

    await queryRunner.query(
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "amountKobo" integer NOT NULL DEFAULT 0`
    );
    await queryRunner.query(
      `UPDATE "payments" SET "amountKobo" = ROUND(amount * 100)::int WHERE "amountKobo" = 0`
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "billingInterval" "public"."plans_interval_enum" DEFAULT NULL`
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payments_reference" ON "payments" ("reference") WHERE "reference" IS NOT NULL`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payments_paystack_ref" ON "payments" ("paystackRef") WHERE "paystackRef" IS NOT NULL`
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "payment_webhook_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "eventKey" character varying NOT NULL, "event" character varying NOT NULL, "reference" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_payment_webhook_events" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payment_webhook_events_key" ON "payment_webhook_events" ("eventKey")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payment_webhook_events"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_payments_paystack_ref"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_payments_reference"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "billingInterval"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "amountKobo"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_billing_plan"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "billingStatus"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "billingInterval"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "billingPlan"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."users_billingstatus_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."users_billingplan_enum"`);
  }
}
