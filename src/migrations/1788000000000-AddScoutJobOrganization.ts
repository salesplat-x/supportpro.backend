import { MigrationInterface, QueryRunner } from "typeorm";

export class AddScoutJobOrganization1788000000000 implements MigrationInterface {
  name = "AddScoutJobOrganization1788000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "scout_jobs"
      ADD COLUMN IF NOT EXISTS "organization_id" uuid
    `);

    // Attribute existing scout jobs to the company their poster is on, then to
    // a company they uniquely own when they have no active workspace.
    await queryRunner.query(`
      UPDATE "scout_jobs" sj
      SET "organization_id" = u."active_organization_id"
      FROM "users" u
      WHERE u.id = sj."posted_by_id"
        AND sj."organization_id" IS NULL
        AND u."active_organization_id" IS NOT NULL
    `);

    await queryRunner.query(`
      UPDATE "scout_jobs" sj
      SET "organization_id" = owned.id
      FROM (
        SELECT "owner_id", MIN(id::text)::uuid AS id
        FROM "organizations"
        WHERE "owner_id" IS NOT NULL
        GROUP BY "owner_id"
        HAVING COUNT(*) = 1
      ) owned
      WHERE owned."owner_id" = sj."posted_by_id"
        AND sj."organization_id" IS NULL
    `);

    await queryRunner.query(`
      UPDATE "ai_configs" c
      SET "organization_id" = j."organization_id"
      FROM "jobs" j
      WHERE j."ai_config_id" = c.id
        AND c."organization_id" IS NULL
        AND j."organization_id" IS NOT NULL
    `);

    await queryRunner.query(`
      UPDATE "ai_configs" c
      SET "organization_id" = u."active_organization_id"
      FROM "users" u
      WHERE u.id = c."recruiter_id"
        AND c."organization_id" IS NULL
        AND u."active_organization_id" IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "scout_jobs"
      DROP CONSTRAINT IF EXISTS "FK_scout_jobs_organization"
    `);
    await queryRunner.query(`
      ALTER TABLE "scout_jobs"
      ADD CONSTRAINT "FK_scout_jobs_organization"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scout_jobs_organization_id"
      ON "scout_jobs" ("organization_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_scout_jobs_organization_id"`);
    await queryRunner.query(
      `ALTER TABLE "scout_jobs" DROP CONSTRAINT IF EXISTS "FK_scout_jobs_organization"`
    );
    await queryRunner.query(`ALTER TABLE "scout_jobs" DROP COLUMN IF EXISTS "organization_id"`);
  }
};
