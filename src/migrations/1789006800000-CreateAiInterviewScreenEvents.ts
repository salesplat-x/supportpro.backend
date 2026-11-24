import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAiInterviewScreenEvents1789006800000 implements MigrationInterface {
  name = "CreateAiInterviewScreenEvents1789006800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_interview_screen_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "interview_id" uuid NOT NULL,
        "question_id" uuid,
        "kind" character varying(24) NOT NULL,
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_interview_screen_events" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_ai_interview_screen_events_kind"
          CHECK ("kind" IN ('tab_hidden', 'window_blur', 'fullscreen_exit')),
        CONSTRAINT "FK_ai_interview_screen_events_interview" FOREIGN KEY ("interview_id")
          REFERENCES "ai_interviews"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_ai_interview_screen_events_question" FOREIGN KEY ("question_id")
          REFERENCES "ai_interview_questions"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_interview_screen_events_interview" ON "ai_interview_screen_events" ("interview_id", "occurred_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ai_interview_screen_events"`);
  }
}
