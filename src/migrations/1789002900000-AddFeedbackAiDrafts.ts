import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFeedbackAiDrafts1789002900000 implements MigrationInterface {
  name = "AddFeedbackAiDrafts1789002900000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The default makes requests the old code saves during the deploy window get drafted too.
    await queryRunner.query(`
      ALTER TABLE "feedback"
        ADD "ai_draft" text,
        ADD "ai_note" text,
        ADD "ai_draft_status" character varying(16) DEFAULT 'pending',
        ADD "ai_draft_attempts" integer NOT NULL DEFAULT 0,
        ADD "ai_draft_next_retry_at" TIMESTAMP WITH TIME ZONE,
        ADD "ai_draft_locked_at" TIMESTAMP WITH TIME ZONE,
        ADD "ai_draft_last_error" text,
        ADD CONSTRAINT "CHK_feedback_ai_draft_status"
          CHECK ("ai_draft_status" IN ('pending', 'drafted', 'complex', 'failed'))
    `);
    await queryRunner.query(`UPDATE "feedback" SET "ai_draft_status" = NULL`);
    await queryRunner.query(
      `CREATE INDEX "IDX_feedback_ai_draft_pending" ON "feedback" ("ai_draft_status") WHERE "ai_draft_status" = 'pending'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_feedback_ai_draft_pending"`);
    await queryRunner.query(`
      ALTER TABLE "feedback"
        DROP CONSTRAINT "CHK_feedback_ai_draft_status",
        DROP COLUMN "ai_draft_last_error",
        DROP COLUMN "ai_draft_locked_at",
        DROP COLUMN "ai_draft_next_retry_at",
        DROP COLUMN "ai_draft_attempts",
        DROP COLUMN "ai_draft_status",
        DROP COLUMN "ai_note",
        DROP COLUMN "ai_draft"
    `);
  }
}
