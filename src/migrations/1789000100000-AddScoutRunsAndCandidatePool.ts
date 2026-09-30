import { MigrationInterface, QueryRunner } from "typeorm";

export class AddScoutRunsAndCandidatePool1789000100000 implements MigrationInterface {
  name = "AddScoutRunsAndCandidatePool1789000100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."scout_runs_status_enum" AS ENUM('processing', 'completed', 'completed_with_errors', 'failed')`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."scouts_status_enum" AS ENUM('queued', 'processing', 'scored', 'failed')`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."scout_candidates_embedding_status_enum" AS ENUM('pending', 'ready', 'failed')`
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "scout_candidates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email_normalized" character varying,
        "full_name" character varying,
        "phone" character varying,
        "headline" character varying,
        "location_city" character varying,
        "location_state" character varying,
        "location_country" character varying,
        "summary" text,
        "skills" text,
        "years_experience" integer,
        "cv_text" text,
        "cv_file_url" character varying,
        "cv_file_key" character varying,
        "embedding" text,
        "embedding_status" "public"."scout_candidates_embedding_status_enum",
        "embedding_attempts" integer NOT NULL DEFAULT 0,
        "embedding_next_retry_at" TIMESTAMP WITH TIME ZONE,
        "embedding_locked_at" TIMESTAMP WITH TIME ZONE,
        "embedding_last_error" text,
        "first_sourced_by_organization_id" uuid,
        "last_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_scout_candidates" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_scout_candidates_email" ON "scout_candidates" ("email_normalized") WHERE "email_normalized" IS NOT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "scout_candidates" ADD CONSTRAINT "FK_scout_candidates_organization" FOREIGN KEY ("first_sourced_by_organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "scout_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "scout_job_id" uuid NOT NULL,
        "recruiter_id" uuid NOT NULL,
        "organization_id" uuid,
        "idempotency_key" character varying NOT NULL,
        "status" "public"."scout_runs_status_enum" NOT NULL DEFAULT 'processing',
        "total_cvs" integer NOT NULL,
        "shortlist_size" integer NOT NULL,
        "shortlist_summary" text,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_scout_runs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_scout_runs_job_idempotency" UNIQUE ("scout_job_id", "idempotency_key")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_scout_runs_job_created" ON "scout_runs" ("scout_job_id", "createdAt")`
    );
    await queryRunner.query(
      `ALTER TABLE "scout_runs" ADD CONSTRAINT "FK_scout_runs_scout_job" FOREIGN KEY ("scout_job_id") REFERENCES "scout_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "scout_runs" ADD CONSTRAINT "FK_scout_runs_recruiter" FOREIGN KEY ("recruiter_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "scout_runs" ADD CONSTRAINT "FK_scout_runs_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );

    await queryRunner.query(`ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "scout_run_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "status" "public"."scouts_status_enum" NOT NULL DEFAULT 'queued'`
    );
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0`
    );
    await queryRunner.query(`ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "position" integer`);
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMP WITH TIME ZONE`
    );
    await queryRunner.query(`ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "locked_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "last_error" text`);
    await queryRunner.query(`ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "rank" integer`);
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "shortlisted" boolean NOT NULL DEFAULT false`
    );
    await queryRunner.query(`ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "recommendation" text`);
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "cv_file_url" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "cv_file_key" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "cv_mime_type" character varying`
    );
    await queryRunner.query(`ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "cv_file_size" integer`);
    await queryRunner.query(`ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "candidate_id" uuid`);

    // Rows that predate the run model were all scored synchronously and succeeded.
    await queryRunner.query(`UPDATE "scouts" SET "status" = 'scored' WHERE "cvScore" IS NOT NULL`);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_scouts_due" ON "scouts" ("status", "next_retry_at")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_scouts_scout_run_id" ON "scouts" ("scout_run_id")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_scouts_candidate_id" ON "scouts" ("candidate_id")`
    );
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD CONSTRAINT "FK_scouts_scout_run" FOREIGN KEY ("scout_run_id") REFERENCES "scout_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD CONSTRAINT "FK_scouts_candidate" FOREIGN KEY ("candidate_id") REFERENCES "scout_candidates"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
    );

    // Mirrors idx_talent_embeddings_hnsw so pool candidates rank as fast as registered talents.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_scout_candidates_hnsw" ON "scout_candidates" USING hnsw ((embedding::vector(512)) vector_cosine_ops)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_scout_candidates_hnsw"`);
    await queryRunner.query(`ALTER TABLE "scouts" DROP CONSTRAINT IF EXISTS "FK_scouts_candidate"`);
    await queryRunner.query(`ALTER TABLE "scouts" DROP CONSTRAINT IF EXISTS "FK_scouts_scout_run"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_scouts_candidate_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_scouts_scout_run_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_scouts_due"`);
    for (const column of [
      "candidate_id",
      "cv_file_size",
      "cv_mime_type",
      "cv_file_key",
      "cv_file_url",
      "recommendation",
      "shortlisted",
      "rank",
      "last_error",
      "locked_at",
      "next_retry_at",
      "attempts",
      "position",
      "status",
      "scout_run_id",
    ]) {
      await queryRunner.query(`ALTER TABLE "scouts" DROP COLUMN IF EXISTS "${column}"`);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS "scout_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "scout_candidates"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."scout_candidates_embedding_status_enum"`
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."scouts_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."scout_runs_status_enum"`);
  }
}
