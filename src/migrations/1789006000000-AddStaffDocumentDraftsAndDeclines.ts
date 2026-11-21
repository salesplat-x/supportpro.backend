import { MigrationInterface, QueryRunner } from "typeorm";

export class AddStaffDocumentDraftsAndDeclines1789006000000 implements MigrationInterface {
  name = "AddStaffDocumentDraftsAndDeclines1789006000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "staff_documents"
        ALTER COLUMN "sent_at" DROP NOT NULL,
        ADD COLUMN "fields" jsonb,
        ADD COLUMN "declined_at" TIMESTAMP,
        ADD COLUMN "notarized_scan_name" character varying(200),
        ADD COLUMN "notarized_by_name" character varying(120)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "staff_documents" WHERE "sent_at" IS NULL`);
    await queryRunner.query(`
      ALTER TABLE "staff_documents"
        DROP COLUMN "notarized_by_name",
        DROP COLUMN "notarized_scan_name",
        DROP COLUMN "declined_at",
        DROP COLUMN "fields",
        ALTER COLUMN "sent_at" SET NOT NULL
    `);
  }
}
