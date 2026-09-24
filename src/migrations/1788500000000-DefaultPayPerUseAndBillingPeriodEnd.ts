import { MigrationInterface, QueryRunner } from "typeorm";

export class DefaultPayPerUseAndBillingPeriodEnd1788500000000 implements MigrationInterface {
  name = "DefaultPayPerUseAndBillingPeriodEnd1788500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organizations"
      ADD COLUMN IF NOT EXISTS "billing_period_end" TIMESTAMP NULL
    `);

    // Product default is pay_per_use; migrate leftover free orgs that never upgraded.
    await queryRunner.query(`
      UPDATE "organizations"
      SET "billing_plan" = 'pay_per_use'
      WHERE "billing_plan" = 'free' OR "billing_plan" IS NULL OR "billing_plan" = ''
    `);

    await queryRunner.query(`
      ALTER TABLE "organizations"
      ALTER COLUMN "billing_plan" SET DEFAULT 'pay_per_use'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organizations"
      ALTER COLUMN "billing_plan" SET DEFAULT 'free'
    `);
    await queryRunner.query(`
      ALTER TABLE "organizations"
      DROP COLUMN IF EXISTS "billing_period_end"
    `);
  }
}
