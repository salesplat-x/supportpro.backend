import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJobPostDetails1789004100000 implements MigrationInterface {
  name = "AddJobPostDetails1789004100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."jobs_employmenttype_enum" AS ENUM('full_time', 'part_time', 'contract', 'internship')`
    );
    await queryRunner.query(`ALTER TABLE "jobs" ADD "department" character varying(100)`);
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "employmentType" "public"."jobs_employmenttype_enum" NOT NULL DEFAULT 'full_time'`
    );
    await queryRunner.query(`ALTER TABLE "jobs" ADD "closesAt" date`);
    await queryRunner.query(`ALTER TABLE "jobs" ADD "shareOptions" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "shareOptions"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "closesAt"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "employmentType"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "department"`);
    await queryRunner.query(`DROP TYPE "public"."jobs_employmenttype_enum"`);
  }
}
