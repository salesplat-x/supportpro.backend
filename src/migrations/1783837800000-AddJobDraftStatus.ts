import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJobDraftStatus1783837800000 implements MigrationInterface {
  name = "AddJobDraftStatus1783837800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."jobs_status_enum" ADD VALUE IF NOT EXISTS 'draft'`
    );
    await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'draft'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres has no native DROP VALUE for enums — 'draft' is left in the type
    // (harmless if unused), matching the pragmatic approach already used for the
    // vector extension in AddVectorSupportAndIndexes. Only the default is reverted.
    await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'active'`);
  }
}
