import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFollowUpsToAiInterviewQuestions1789003300000 implements MigrationInterface {
  name = "AddFollowUpsToAiInterviewQuestions1789003300000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD "is_follow_up" boolean NOT NULL DEFAULT false`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" DROP CONSTRAINT "UQ_ai_interview_questions_position"`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD CONSTRAINT "UQ_ai_interview_questions_position_follow_up" UNIQUE ("interview_id", "position", "is_follow_up")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "ai_interview_questions" WHERE "is_follow_up" = true`);
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" DROP CONSTRAINT "UQ_ai_interview_questions_position_follow_up"`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_interview_questions" ADD CONSTRAINT "UQ_ai_interview_questions_position" UNIQUE ("interview_id", "position")`
    );
    await queryRunner.query(`ALTER TABLE "ai_interview_questions" DROP COLUMN "is_follow_up"`);
  }
}
