import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCompensationPeriodToUsers1784700700000 implements MigrationInterface {
  name = "AddCompensationPeriodToUsers1784700700000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."users_compensationperiod_enum" AS ENUM('monthly', 'yearly')`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "compensationPeriod" "public"."users_compensationperiod_enum" DEFAULT 'yearly'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "compensationPeriod"`);
    await queryRunner.query(`DROP TYPE "public"."users_compensationperiod_enum"`);
  }
}
