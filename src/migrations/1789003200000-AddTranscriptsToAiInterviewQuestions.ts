import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTranscriptsToAiInterviewQuestions1789003200000 implements MigrationInterface {
  name = "AddTranscriptsToAiInterviewQuestions1789003200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD "transcript_status" character varying(20)`
    );
    await queryRunner.query(`ALTER TABLE "ai_interview_questions" ADD "transcript" text`);
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD "transcribed_at" TIMESTAMP WITH TIME ZONE`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD "transcript_attempts" integer NOT NULL DEFAULT 0`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD "transcript_next_retry_at" TIMESTAMP WITH TIME ZONE`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD "transcript_locked_at" TIMESTAMP WITH TIME ZONE`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD "transcript_last_error" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" DROP COLUMN "transcript_last_error"`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" DROP COLUMN "transcript_locked_at"`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" DROP COLUMN "transcript_next_retry_at"`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" DROP COLUMN "transcript_attempts"`
    );
    await queryRunner.query(`ALTER TABLE "ai_interview_questions" DROP COLUMN "transcribed_at"`);
    await queryRunner.query(`ALTER TABLE "ai_interview_questions" DROP COLUMN "transcript"`);
    await queryRunner.query(`ALTER TABLE "ai_interview_questions" DROP COLUMN "transcript_status"`);
  }
}
