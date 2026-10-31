import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateChecklistNotarizationAndCompanyProfile1789001500000 implements MigrationInterface {
  name = "CreateChecklistNotarizationAndCompanyProfile1789001500000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "staff_checklist_tasks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "staff_id" uuid NOT NULL,
        "title" character varying(120) NOT NULL,
        "due_on" date,
        "done_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_checklist_tasks_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_staff_checklist_tasks_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_checklist_tasks_staff" ON "staff_checklist_tasks" ("staff_id")`
    );
    await queryRunner.query(`
      ALTER TABLE "organizations"
        ADD "mission" text,
        ADD "vision" text,
        ADD "yearly_goals" jsonb NOT NULL DEFAULT '[]',
        ADD "default_checklist" jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE "staff_documents"
        ADD "needs_notarization" boolean NOT NULL DEFAULT false,
        ADD "notarized_scan_key" character varying(300),
        ADD "notarized_scan_type" character varying(64),
        ADD "notarized_at" TIMESTAMP
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "staff_documents"
        DROP COLUMN "notarized_at",
        DROP COLUMN "notarized_scan_type",
        DROP COLUMN "notarized_scan_key",
        DROP COLUMN "needs_notarization"
    `);
    await queryRunner.query(`
      ALTER TABLE "organizations"
        DROP COLUMN "default_checklist",
        DROP COLUMN "yearly_goals",
        DROP COLUMN "vision",
        DROP COLUMN "mission"
    `);
    await queryRunner.query(`DROP TABLE "staff_checklist_tasks"`);
  }
}
