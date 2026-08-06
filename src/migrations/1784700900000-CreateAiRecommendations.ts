import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAiRecommendations1784700900000 implements MigrationInterface {
  name = "CreateAiRecommendations1784700900000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_recommendations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "application_id" uuid NOT NULL,
        "verdict" "public"."applications_matchverdict_enum" NOT NULL,
        "reasoning" text NOT NULL,
        "recommendation" "public"."applications_matchrecommendation_enum",
        "strengths" jsonb,
        "weaknesses" jsonb,
        "risks" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_recommendations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_ai_recommendations_application" UNIQUE ("application_id"),
        CONSTRAINT "FK_ai_recommendations_application"
          FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_recommendations_application_id" ON "ai_recommendations" ("application_id")`
    );

    // Backfill from existing application match columns so we don't re-call OpenAI.
    await queryRunner.query(`
      INSERT INTO "ai_recommendations" (
        "application_id", "verdict", "reasoning", "recommendation",
        "strengths", "weaknesses", "risks"
      )
      SELECT
        a.id,
        a."matchVerdict",
        COALESCE(a."matchVerdictReasoning", ''),
        a."matchRecommendation",
        a."matchStrengths",
        a."matchWeaknesses",
        a."matchRisks"
      FROM "applications" a
      WHERE a."matchVerdict" IS NOT NULL
      ON CONFLICT ("application_id") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ai_recommendations_application_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_recommendations"`);
  }
}
