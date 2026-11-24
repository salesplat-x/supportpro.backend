import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateStaffGoalReports1789006600000 implements MigrationInterface {
  name = "CreateStaffGoalReports1789006600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "staff_goals" ADD "report_frequency" character varying(16)`
    );
    await queryRunner.query(`ALTER TABLE "staff_goals" ADD "report_frequency_since" date`);
    await queryRunner.query(`
      ALTER TABLE "staff_goals" ADD CONSTRAINT "CHK_staff_goals_report_frequency"
        CHECK ("report_frequency" IS NULL OR "report_frequency" IN ('daily', 'weekly', 'monthly'))
    `);
    await queryRunner.query(`
      CREATE TABLE "staff_goal_reports" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "staff_id" uuid NOT NULL,
        "goal_id" uuid NOT NULL,
        "frequency" character varying(16) NOT NULL,
        "period_start" date NOT NULL,
        "text" text,
        "links" jsonb NOT NULL DEFAULT '[]',
        "files" jsonb NOT NULL DEFAULT '[]',
        "text_version" integer NOT NULL DEFAULT 1,
        "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reviewer_note" text,
        "reviewer_note_by_name" character varying(241),
        "reviewer_note_at" TIMESTAMP WITH TIME ZONE,
        "note_version" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_staff_goal_reports" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_staff_goal_reports_frequency"
          CHECK ("frequency" IN ('daily', 'weekly', 'monthly')),
        CONSTRAINT "FK_staff_goal_reports_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_goal_reports_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_goal_reports_goal" FOREIGN KEY ("goal_id")
          REFERENCES "staff_goals"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_staff_goal_reports_period" ON "staff_goal_reports" ("goal_id", "period_start")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_goal_reports_staff_submitted" ON "staff_goal_reports" ("staff_id", "submitted_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "staff_goal_reports"`);
    await queryRunner.query(
      `ALTER TABLE "staff_goals" DROP CONSTRAINT "CHK_staff_goals_report_frequency"`
    );
    await queryRunner.query(`ALTER TABLE "staff_goals" DROP COLUMN "report_frequency_since"`);
    await queryRunner.query(`ALTER TABLE "staff_goals" DROP COLUMN "report_frequency"`);
  }
}
