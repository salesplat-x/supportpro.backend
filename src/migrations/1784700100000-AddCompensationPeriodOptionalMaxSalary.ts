import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCompensationPeriodOptionalMaxSalary1784700100000 implements MigrationInterface {
  name = "AddCompensationPeriodOptionalMaxSalary1784700100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."jobs_compensationperiod_enum" AS ENUM('monthly', 'yearly')`
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "compensationPeriod" "public"."jobs_compensationperiod_enum" NOT NULL DEFAULT 'yearly'`
    );
    await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "maxSalary" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "jobs" SET "maxSalary" = "minSalary" WHERE "maxSalary" IS NULL`
    );
    await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "maxSalary" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "compensationPeriod"`);
    await queryRunner.query(`DROP TYPE "public"."jobs_compensationperiod_enum"`);
  }
}
