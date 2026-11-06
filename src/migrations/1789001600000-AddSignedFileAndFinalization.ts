import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSignedFileAndFinalization1789001600000 implements MigrationInterface {
  name = "AddSignedFileAndFinalization1789001600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "staff_documents"
        ADD "check_code_version" smallint NOT NULL DEFAULT 1,
        ADD "check_stamp" character varying(32),
        ADD "signed_file_key" character varying(300),
        ADD "signed_file_hash" character varying(64),
        ADD "employee_copy_sent_at" TIMESTAMP WITH TIME ZONE,
        ADD "company_copy_sent_at" TIMESTAMP WITH TIME ZONE,
        ADD "finalized_at" TIMESTAMP WITH TIME ZONE,
        ADD "finalize_attempts" integer NOT NULL DEFAULT 0,
        ADD "finalize_next_retry_at" TIMESTAMP WITH TIME ZONE,
        ADD "finalize_locked_at" TIMESTAMP WITH TIME ZONE,
        ADD "finalize_error" text
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_staff_documents_signed_file_hash" ON "staff_documents" ("signed_file_hash")
        WHERE "signed_file_hash" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_staff_documents_finalize_due" ON "staff_documents" ("finalize_next_retry_at")
        WHERE "finalized_at" IS NULL AND "finalize_next_retry_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_staff_documents_finalize_due"`);
    await queryRunner.query(`DROP INDEX "IDX_staff_documents_signed_file_hash"`);
    await queryRunner.query(`
      ALTER TABLE "staff_documents"
        DROP COLUMN "finalize_error",
        DROP COLUMN "finalize_locked_at",
        DROP COLUMN "finalize_next_retry_at",
        DROP COLUMN "finalize_attempts",
        DROP COLUMN "finalized_at",
        DROP COLUMN "company_copy_sent_at",
        DROP COLUMN "employee_copy_sent_at",
        DROP COLUMN "signed_file_hash",
        DROP COLUMN "signed_file_key",
        DROP COLUMN "check_stamp",
        DROP COLUMN "check_code_version"
    `);
  }
}
