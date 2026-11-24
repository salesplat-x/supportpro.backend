import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInterviewQuestionAudio1789006700000 implements MigrationInterface {
  name = "AddInterviewQuestionAudio1789006700000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD "audio_key" character varying(255)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_interview_questions" DROP COLUMN "audio_key"`);
  }
}
