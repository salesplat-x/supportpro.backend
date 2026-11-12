import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDurationToAiInterviewQuestions1789004200000 implements MigrationInterface {
  name = "AddDurationToAiInterviewQuestions1789004200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD "recording_duration_seconds" double precision`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" DROP COLUMN "recording_duration_seconds"`
    );
  }
}
