import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFeedbackReplies1789002800000 implements MigrationInterface {
  name = "AddFeedbackReplies1789002800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "feedback"
        ADD "topic" character varying(32),
        ADD "client_request_id" uuid,
        ADD "reply" text,
        ADD "replied_at" TIMESTAMP WITH TIME ZONE,
        ADD "replied_by_id" uuid,
        ADD "reply_email_status" character varying(16),
        ADD "reply_email_error" text,
        ADD "draft_reply" text,
        ADD "draft_updated_at" TIMESTAMP WITH TIME ZONE,
        ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        ADD CONSTRAINT "CHK_feedback_topic"
          CHECK ("topic" IN ('account', 'billing', 'jobs', 'applications', 'bug', 'idea', 'other')),
        ADD CONSTRAINT "CHK_feedback_reply_email_status"
          CHECK ("reply_email_status" IN ('pending', 'sent', 'failed')),
        ADD CONSTRAINT "FK_feedback_replied_by" FOREIGN KEY ("replied_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_feedback_user_client_request" ON "feedback" ("user_id", "client_request_id") WHERE "client_request_id" IS NOT NULL`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_feedback_replied_at_createdAt" ON "feedback" ("replied_at", "createdAt")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_feedback_replied_at_createdAt"`);
    await queryRunner.query(`DROP INDEX "UQ_feedback_user_client_request"`);
    await queryRunner.query(`
      ALTER TABLE "feedback"
        DROP CONSTRAINT "FK_feedback_replied_by",
        DROP CONSTRAINT "CHK_feedback_reply_email_status",
        DROP CONSTRAINT "CHK_feedback_topic",
        DROP COLUMN "updated_at",
        DROP COLUMN "draft_updated_at",
        DROP COLUMN "draft_reply",
        DROP COLUMN "reply_email_error",
        DROP COLUMN "reply_email_status",
        DROP COLUMN "replied_by_id",
        DROP COLUMN "replied_at",
        DROP COLUMN "reply",
        DROP COLUMN "client_request_id",
        DROP COLUMN "topic"
    `);
  }
}
