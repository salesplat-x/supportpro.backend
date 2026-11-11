import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAiInterviews1789003050000 implements MigrationInterface {
  name = "CreateAiInterviews1789003050000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ADD "aiInterview" boolean NOT NULL DEFAULT false`
    );
    await queryRunner.query(`ALTER TABLE "ai_configs" ADD "aiInterviewMode" character varying(20)`);
    await queryRunner.query(
      `ALTER TYPE "public"."applications_currentstage_enum" ADD VALUE IF NOT EXISTS 'ai_interview' BEFORE 'completed'`
    );
    await queryRunner.query(`
      CREATE TABLE "ai_interviews" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "application_id" uuid NOT NULL,
        "job_id" uuid NOT NULL,
        "talent_id" uuid NOT NULL,
        "mode" character varying(20) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "invited_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_interviews_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ai_interviews_application" FOREIGN KEY ("application_id")
          REFERENCES "applications"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_ai_interviews_job" FOREIGN KEY ("job_id")
          REFERENCES "jobs"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_ai_interviews_talent" FOREIGN KEY ("talent_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_ai_interviews_application" ON "ai_interviews" ("application_id")`
    );
    await queryRunner.query(`
      CREATE TABLE "ai_interview_questions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "interview_id" uuid NOT NULL,
        "position" integer NOT NULL,
        "question" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_interview_questions_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_ai_interview_questions_position" UNIQUE ("interview_id", "position"),
        CONSTRAINT "FK_ai_interview_questions_interview" FOREIGN KEY ("interview_id")
          REFERENCES "ai_interviews"("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const parked = await queryRunner.query(
      `SELECT COUNT(*)::int AS n FROM "applications" WHERE "currentStage" = 'ai_interview'`
    );
    if (Number(parked[0]?.n ?? 0) > 0) {
      throw new Error(
        `CreateAiInterviews down: ${parked[0].n} application(s) are at the ai_interview stage; move them first`
      );
    }
    await queryRunner.query(`DROP TABLE "ai_interview_questions"`);
    await queryRunner.query(`DROP TABLE "ai_interviews"`);
    await queryRunner.query(`ALTER TABLE "applications" ALTER COLUMN "currentStage" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TYPE "public"."applications_currentstage_enum" RENAME TO "applications_currentstage_enum_old"`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."applications_currentstage_enum" AS ENUM('prescreening', 'cv_similarity', 'personalized', 'personality', 'completed')`
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ALTER COLUMN "currentStage" TYPE "public"."applications_currentstage_enum" USING "currentStage"::text::"public"."applications_currentstage_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."applications_currentstage_enum_old"`);
    await queryRunner.query(
      `ALTER TABLE "applications" ALTER COLUMN "currentStage" SET DEFAULT 'personality'`
    );
    await queryRunner.query(`ALTER TABLE "ai_configs" DROP COLUMN "aiInterviewMode"`);
    await queryRunner.query(`ALTER TABLE "ai_configs" DROP COLUMN "aiInterview"`);
  }
}
