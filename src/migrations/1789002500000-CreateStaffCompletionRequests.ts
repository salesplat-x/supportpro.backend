import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateStaffCompletionRequests1789002500000 implements MigrationInterface {
  name = "CreateStaffCompletionRequests1789002500000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "staff_goals"
        ADD "completed_at" TIMESTAMP WITH TIME ZONE,
        ADD "completed_by_name" character varying(241)
    `);
    await queryRunner.query(`
      UPDATE "staff_goals" g
      SET "completed_at" = COALESCE(
        (SELECT MAX(e."created_at") FROM "staff_goal_progress_events" e
         WHERE e."goal_id" = g."id" AND e."to_progress" = 100),
        g."approved_at"
      )
      WHERE g."progress" = 100 AND g."status" = 'approved'
    `);
    await queryRunner.query(`
      ALTER TABLE "staff_goals" ADD CONSTRAINT "CHK_staff_goals_completed"
        CHECK (("progress" = 100) = ("completed_at" IS NOT NULL)
          AND ("completed_at" IS NULL OR "status" = 'approved'))
    `);
    await queryRunner.query(
      `ALTER TABLE "staff_checklist_tasks" ADD "completed_by_name" character varying(241)`
    );
    await queryRunner.query(`
      CREATE TABLE "staff_completion_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "staff_id" uuid NOT NULL,
        "goal_id" uuid,
        "task_id" uuid,
        "summary" text NOT NULL,
        "links" jsonb NOT NULL DEFAULT '[]',
        "files" jsonb NOT NULL DEFAULT '[]',
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "review_note" text,
        "reviewed_by_name" character varying(241),
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "submitted_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_completion_requests" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_staff_completion_requests_item" CHECK (num_nonnulls("goal_id", "task_id") = 1),
        CONSTRAINT "FK_staff_completion_requests_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_completion_requests_goal" FOREIGN KEY ("goal_id")
          REFERENCES "staff_goals"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_completion_requests_task" FOREIGN KEY ("task_id")
          REFERENCES "staff_checklist_tasks"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_completion_requests_submitted_by" FOREIGN KEY ("submitted_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_completion_requests_staff" ON "staff_completion_requests" ("staff_id", "status")`
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_staff_completion_requests_goal_pending"
        ON "staff_completion_requests" ("goal_id")
        WHERE "goal_id" IS NOT NULL AND "status" = 'pending'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_staff_completion_requests_task_pending"
        ON "staff_completion_requests" ("task_id")
        WHERE "task_id" IS NOT NULL AND "status" = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "staff_completion_requests"`);
    await queryRunner.query(`ALTER TABLE "staff_checklist_tasks" DROP COLUMN "completed_by_name"`);
    await queryRunner.query(`ALTER TABLE "staff_goals" DROP CONSTRAINT "CHK_staff_goals_completed"`);
    await queryRunner.query(`
      ALTER TABLE "staff_goals"
        DROP COLUMN "completed_by_name",
        DROP COLUMN "completed_at"
    `);
  }
}
