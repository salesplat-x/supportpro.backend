import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSavedJobs1789004500000 implements MigrationInterface {
  name = "CreateSavedJobs1789004500000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "saved_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "job_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_saved_jobs_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_saved_jobs_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_saved_jobs_job" FOREIGN KEY ("job_id")
          REFERENCES "jobs"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_saved_jobs_user_job" ON "saved_jobs" ("user_id", "job_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "saved_jobs"`);
  }
}
