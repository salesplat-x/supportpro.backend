import { MigrationInterface, QueryRunner } from "typeorm";

export class AddScoutCampaignTargeting1789000000000 implements MigrationInterface {
  name = "AddScoutCampaignTargeting1789000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."scout_jobs_experience_level_enum" AS ENUM('1-3 years', '4-6 years', '7-10 years', '11-15 years', '16 years and above')`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."scout_jobs_work_mode_enum" AS ENUM('remote', 'onSite', 'hybrid')`
    );

    await queryRunner.query(
      `ALTER TABLE "scout_jobs" ADD COLUMN IF NOT EXISTS "shortlist_size" integer NOT NULL DEFAULT 5`
    );
    await queryRunner.query(
      `ALTER TABLE "scout_jobs" ADD CONSTRAINT "CHK_scout_jobs_shortlist_size" CHECK ("shortlist_size" BETWEEN 2 AND 10)`
    );
    await queryRunner.query(
      `ALTER TABLE "scout_jobs" ADD COLUMN IF NOT EXISTS "experience_level" "public"."scout_jobs_experience_level_enum"`
    );
    await queryRunner.query(
      `ALTER TABLE "scout_jobs" ADD COLUMN IF NOT EXISTS "must_have_skills" text`
    );
    await queryRunner.query(
      `ALTER TABLE "scout_jobs" ADD COLUMN IF NOT EXISTS "nice_to_have_skills" text`
    );
    await queryRunner.query(
      `ALTER TABLE "scout_jobs" ADD COLUMN IF NOT EXISTS "work_mode" "public"."scout_jobs_work_mode_enum"`
    );
    await queryRunner.query(
      `ALTER TABLE "scout_jobs" ADD COLUMN IF NOT EXISTS "location_country" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "scout_jobs" ADD COLUMN IF NOT EXISTS "location_state" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "scout_jobs" ADD COLUMN IF NOT EXISTS "location_city" character varying`
    );

    // Written on every campaign create (costing an embedding call) and read nowhere —
    // only jobs.job_embedding backs the vector search.
    await queryRunner.query(`ALTER TABLE "scout_jobs" DROP COLUMN IF EXISTS "job_embedding"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scout_jobs" ADD COLUMN IF NOT EXISTS "job_embedding" text`
    );
    await queryRunner.query(`ALTER TABLE "scout_jobs" DROP COLUMN IF EXISTS "location_city"`);
    await queryRunner.query(`ALTER TABLE "scout_jobs" DROP COLUMN IF EXISTS "location_state"`);
    await queryRunner.query(`ALTER TABLE "scout_jobs" DROP COLUMN IF EXISTS "location_country"`);
    await queryRunner.query(`ALTER TABLE "scout_jobs" DROP COLUMN IF EXISTS "work_mode"`);
    await queryRunner.query(`ALTER TABLE "scout_jobs" DROP COLUMN IF EXISTS "nice_to_have_skills"`);
    await queryRunner.query(`ALTER TABLE "scout_jobs" DROP COLUMN IF EXISTS "must_have_skills"`);
    await queryRunner.query(`ALTER TABLE "scout_jobs" DROP COLUMN IF EXISTS "experience_level"`);
    await queryRunner.query(
      `ALTER TABLE "scout_jobs" DROP CONSTRAINT IF EXISTS "CHK_scout_jobs_shortlist_size"`
    );
    await queryRunner.query(`ALTER TABLE "scout_jobs" DROP COLUMN IF EXISTS "shortlist_size"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."scout_jobs_work_mode_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."scout_jobs_experience_level_enum"`);
  }
}
