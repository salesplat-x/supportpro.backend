import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateJobDescriptionsAndGoals1789001800000 implements MigrationInterface {
  name = "CreateJobDescriptionsAndGoals1789001800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "staff_job_descriptions" (
        "staff_id" uuid NOT NULL,
        "body" text NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        "updated_by_name" character varying(241) NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_job_descriptions_staff" PRIMARY KEY ("staff_id"),
        CONSTRAINT "FK_staff_job_descriptions_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "staff_goals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "staff_id" uuid NOT NULL,
        "title" character varying(200) NOT NULL,
        "key_results" jsonb NOT NULL DEFAULT '[]',
        "target" character varying(200),
        "due_on" date NOT NULL,
        "progress" smallint NOT NULL DEFAULT 0,
        "status" character varying(16) NOT NULL DEFAULT 'draft',
        "source" character varying(16) NOT NULL DEFAULT 'manual',
        "version" integer NOT NULL DEFAULT 1,
        "approved_by_name" character varying(241),
        "approved_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_goals_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_staff_goals_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_goals_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_staff_goals_progress" CHECK ("progress" BETWEEN 0 AND 100),
        CONSTRAINT "CHK_staff_goals_approved" CHECK (("status" = 'approved') = ("approved_at" IS NOT NULL))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_goals_staff" ON "staff_goals" ("staff_id", "status")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_goals_org" ON "staff_goals" ("organization_id", "status")`
    );
    await queryRunner.query(`
      CREATE TABLE "staff_goal_progress_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "goal_id" uuid NOT NULL,
        "from_progress" smallint NOT NULL,
        "to_progress" smallint NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_goal_progress_events_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_staff_goal_progress_events_goal" FOREIGN KEY ("goal_id")
          REFERENCES "staff_goals"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_goal_progress_events_goal" ON "staff_goal_progress_events" ("goal_id", "created_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "staff_goal_progress_events"`);
    await queryRunner.query(`DROP TABLE "staff_goals"`);
    await queryRunner.query(`DROP TABLE "staff_job_descriptions"`);
  }
}
