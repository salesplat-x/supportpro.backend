import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAssessmentToAiInterviews1789003400000 implements MigrationInterface {
  name = "AddAssessmentToAiInterviews1789003400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_interviews" ADD "scoring_status" character varying(20)`
    );
    await queryRunner.query(`ALTER TABLE "ai_interviews" ADD "scores" jsonb`);
    await queryRunner.query(`ALTER TABLE "ai_interviews" ADD "summary" text`);
    await queryRunner.query(`ALTER TABLE "ai_interviews" ADD "flags" jsonb`);
    await queryRunner.query(`ALTER TABLE "ai_interviews" ADD "scored_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `ALTER TABLE "ai_interviews" ADD "scoring_attempts" integer NOT NULL DEFAULT 0`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interviews" ADD "scoring_next_retry_at" TIMESTAMP WITH TIME ZONE`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interviews" ADD "scoring_locked_at" TIMESTAMP WITH TIME ZONE`
    );
    await queryRunner.query(`ALTER TABLE "ai_interviews" ADD "scoring_last_error" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_interviews" DROP COLUMN "scoring_last_error"`);
    await queryRunner.query(`ALTER TABLE "ai_interviews" DROP COLUMN "scoring_locked_at"`);
    await queryRunner.query(`ALTER TABLE "ai_interviews" DROP COLUMN "scoring_next_retry_at"`);
    await queryRunner.query(`ALTER TABLE "ai_interviews" DROP COLUMN "scoring_attempts"`);
    await queryRunner.query(`ALTER TABLE "ai_interviews" DROP COLUMN "scored_at"`);
    await queryRunner.query(`ALTER TABLE "ai_interviews" DROP COLUMN "flags"`);
    await queryRunner.query(`ALTER TABLE "ai_interviews" DROP COLUMN "summary"`);
    await queryRunner.query(`ALTER TABLE "ai_interviews" DROP COLUMN "scores"`);
    await queryRunner.query(`ALTER TABLE "ai_interviews" DROP COLUMN "scoring_status"`);
  }
}
