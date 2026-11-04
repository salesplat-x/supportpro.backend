import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateWeeklyReports1789001900000 implements MigrationInterface {
  name = "CreateWeeklyReports1789001900000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "staff_weekly_reports" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "staff_id" uuid NOT NULL,
        "week_start" date NOT NULL,
        "did" text NOT NULL,
        "blocked" text NOT NULL,
        "next_week" text NOT NULL,
        "text_version" integer NOT NULL DEFAULT 1,
        "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "manager_note" text,
        "manager_note_by_name" character varying(241),
        "manager_note_at" TIMESTAMP WITH TIME ZONE,
        "note_version" integer NOT NULL DEFAULT 0,
        "advice" jsonb,
        "advice_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_staff_weekly_reports_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_staff_weekly_reports_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_weekly_reports_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_staff_weekly_reports_staff_week" ON "staff_weekly_reports" ("staff_id", "week_start")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "staff_weekly_reports"`);
  }
}
