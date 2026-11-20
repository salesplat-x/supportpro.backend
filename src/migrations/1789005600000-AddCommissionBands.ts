import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Plans pay by bands of sales instead of tiers of target. Existing plans keep their
 * tiers and have no bands until the owner edits them; plans the previous release
 * writes during the deploy window get the same state.
 */
export class AddCommissionBands1789005600000 implements MigrationInterface {
  name = "AddCommissionBands1789005600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "commission_plans" ADD "bands" jsonb`);
    await queryRunner.query(`ALTER TABLE "commission_plans" ADD "paid_on" character varying(32)`);
    await queryRunner.query(`ALTER TABLE "commission_plans" ADD "frequency" character varying(16)`);
    await queryRunner.query(`ALTER TABLE "commission_plans" ALTER COLUMN "tiers" SET DEFAULT '[]'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "commission_plans" ALTER COLUMN "tiers" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "commission_plans" DROP COLUMN "frequency"`);
    await queryRunner.query(`ALTER TABLE "commission_plans" DROP COLUMN "paid_on"`);
    await queryRunner.query(`ALTER TABLE "commission_plans" DROP COLUMN "bands"`);
  }
}
