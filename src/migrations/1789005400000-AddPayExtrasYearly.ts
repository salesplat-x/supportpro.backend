import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Bonus and commission target used to follow the salary period. Existing rows keep
 * false (and so do rows the previous release writes during the deploy window), so
 * monthly ones are read as twelve times their stored amount; new rows store yearly
 * amounts with true.
 */
export class AddPayExtrasYearly1789005400000 implements MigrationInterface {
  name = "AddPayExtrasYearly1789005400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pay_packages" ADD "extras_yearly" boolean NOT NULL DEFAULT false`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "pay_packages" DROP COLUMN "extras_yearly"`);
  }
}
