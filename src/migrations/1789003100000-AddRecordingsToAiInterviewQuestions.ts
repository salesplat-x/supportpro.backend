import { MigrationInterface, QueryRunner } from "typeorm";

export class AddRecordingsToAiInterviewQuestions1789003100000 implements MigrationInterface {
  name = "AddRecordingsToAiInterviewQuestions1789003100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD "recording_key" character varying(255)`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD "recording_mime_type" character varying(100)`
    );
    await queryRunner.query(`ALTER TABLE "ai_interview_questions" ADD "recording_size" integer`);
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD "recorded_at" TIMESTAMP WITH TIME ZONE`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_interview_questions" DROP COLUMN "recorded_at"`);
    await queryRunner.query(`ALTER TABLE "ai_interview_questions" DROP COLUMN "recording_size"`);
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" DROP COLUMN "recording_mime_type"`
    );
    await queryRunner.query(`ALTER TABLE "ai_interview_questions" DROP COLUMN "recording_key"`);
  }
}
