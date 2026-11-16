import { MigrationInterface, QueryRunner } from "typeorm";

export const STAMP_STAGE_REACHED_FUNCTION = `
  CREATE OR REPLACE FUNCTION "applications_stamp_stage_reached"() RETURNS trigger AS $$
  BEGIN
    IF TG_OP = 'INSERT' OR NEW."currentStage" IS DISTINCT FROM OLD."currentStage" THEN
      NEW."stageReachedAt" := jsonb_build_object(NEW."currentStage"::text, now())
        || COALESCE(NEW."stageReachedAt", '{}'::jsonb);
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql
`;

export const STAMP_STAGE_REACHED_TRIGGER = `CREATE TRIGGER "applications_stamp_stage_reached" BEFORE INSERT OR UPDATE ON "applications" FOR EACH ROW EXECUTE FUNCTION "applications_stamp_stage_reached"()`;

export class AddAssessmentScreeningStages1789004400000 implements MigrationInterface {
  name = "AddAssessmentScreeningStages1789004400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."applications_currentstage_enum" ADD VALUE IF NOT EXISTS 'problem_solving' BEFORE 'ai_interview'`
    );
    await queryRunner.query(
      `ALTER TYPE "public"."applications_currentstage_enum" ADD VALUE IF NOT EXISTS 'culture_fit' BEFORE 'ai_interview'`
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "stageReachedAt" jsonb NOT NULL DEFAULT '{}'`
    );
    await queryRunner.query(STAMP_STAGE_REACHED_FUNCTION);
    await queryRunner.query(STAMP_STAGE_REACHED_TRIGGER);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "applications_stamp_stage_reached" ON "applications"`
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS "applications_stamp_stage_reached"()`);
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "stageReachedAt"`);
  }
}
