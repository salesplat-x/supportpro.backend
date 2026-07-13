import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJobDraftStatus1783837800000 implements MigrationInterface {
  name = "AddJobDraftStatus1783837800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Postgres forbids using a newly-added enum value in the same transaction
    // that added it (even indirectly, e.g. via a column DEFAULT) — the default
    // change lives in the next migration so it commits separately.
    await queryRunner.query(
      `ALTER TYPE "public"."jobs_status_enum" ADD VALUE IF NOT EXISTS 'draft'`
    );
  }

  public async down(): Promise<void> {
    // Postgres has no native DROP VALUE for enums — 'draft' is left in the type
    // (harmless if unused), matching the pragmatic approach already used for the
    // vector extension in AddVectorSupportAndIndexes.
  }
}
