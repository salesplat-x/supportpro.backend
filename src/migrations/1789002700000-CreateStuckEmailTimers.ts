import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateStuckEmailTimers1789002700000 implements MigrationInterface {
  name = "CreateStuckEmailTimers1789002700000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "stuck_email_timers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "application_id" uuid,
        "scope_key" character varying(64) NOT NULL,
        "stage" character varying(32) NOT NULL,
        "stuck_since" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "first_sent_at" TIMESTAMP WITH TIME ZONE,
        "second_sent_at" TIMESTAMP WITH TIME ZONE,
        "claimed_at" TIMESTAMP WITH TIME ZONE,
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "closed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_stuck_email_timers" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_stuck_email_timers_step" UNIQUE ("user_id", "scope_key", "stage"),
        CONSTRAINT "FK_stuck_email_timers_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_stuck_email_timers_application" FOREIGN KEY ("application_id")
          REFERENCES "applications"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_stuck_email_timers_open" ON "stuck_email_timers" ("closed_at", "stuck_since")`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "follow_up_emails_opted_out_at" TIMESTAMP WITH TIME ZONE`
    );
    await queryRunner.query(
      `ALTER TABLE "onboarding_emails" ADD "source" character varying(16) NOT NULL DEFAULT 'admin'`
    );
    await queryRunner.query(
      `ALTER TABLE "application_follow_up_emails" ADD "source" character varying(16) NOT NULL DEFAULT 'admin'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "application_follow_up_emails" DROP COLUMN "source"`);
    await queryRunner.query(`ALTER TABLE "onboarding_emails" DROP COLUMN "source"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "follow_up_emails_opted_out_at"`);
    await queryRunner.query(`DROP TABLE "stuck_email_timers"`);
  }
}
