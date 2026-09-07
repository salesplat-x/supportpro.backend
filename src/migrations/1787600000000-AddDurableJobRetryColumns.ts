import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDurableJobRetryColumns1787600000000 implements MigrationInterface {
  name = "AddDurableJobRetryColumns1787600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "matchVerdictAttempts" integer NOT NULL DEFAULT 0`
    );
    await queryRunner.query(`ALTER TABLE "applications" ADD "matchVerdictNextRetryAt" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "applications" ADD "matchVerdictLockedAt" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "applications" ADD "matchVerdictLastError" text`);

    await queryRunner.query(
      `CREATE TYPE "public"."users_cvembeddingstatus_enum" AS ENUM('pending', 'ready', 'failed')`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "cvEmbeddingStatus" "public"."users_cvembeddingstatus_enum"`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "cvEmbeddingAttempts" integer NOT NULL DEFAULT 0`
    );
    await queryRunner.query(`ALTER TABLE "users" ADD "cvEmbeddingNextRetryAt" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "users" ADD "cvEmbeddingLockedAt" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "users" ADD "cvEmbeddingLastError" text`);

    await queryRunner.query(
      `CREATE TYPE "public"."pre_screenings_generationstatus_enum" AS ENUM('pending', 'succeeded', 'failed')`
    );
    await queryRunner.query(
      `ALTER TABLE "pre_screenings" ADD "generationStatus" "public"."pre_screenings_generationstatus_enum" NOT NULL DEFAULT 'succeeded'`
    );
    await queryRunner.query(
      `ALTER TABLE "pre_screenings" ADD "generationAttempts" integer NOT NULL DEFAULT 0`
    );
    await queryRunner.query(`ALTER TABLE "pre_screenings" ADD "generationNextRetryAt" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "pre_screenings" ADD "generationLockedAt" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "pre_screenings" ADD "generationLastError" text`);

    // Heal CVs that already have embeddings vs those still waiting.
    await queryRunner.query(`
      UPDATE "users" u
      SET "cvEmbeddingStatus" = 'ready'
      WHERE u."cvText" IS NOT NULL
        AND EXISTS (SELECT 1 FROM talent_embeddings te WHERE te.user_id = u."id")
    `);
    await queryRunner.query(`
      UPDATE "users" u
      SET "cvEmbeddingStatus" = 'pending'
      WHERE u."cvText" IS NOT NULL
        AND u."cvUploadedAt" IS NOT NULL
        AND u."cvEmbeddingStatus" IS NULL
    `);

    await queryRunner.query(`
      UPDATE "pre_screenings"
      SET "generationStatus" = 'pending'
      WHERE questions = '[]'::jsonb OR questions IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "pre_screenings" DROP COLUMN "generationLastError"`);
    await queryRunner.query(`ALTER TABLE "pre_screenings" DROP COLUMN "generationLockedAt"`);
    await queryRunner.query(`ALTER TABLE "pre_screenings" DROP COLUMN "generationNextRetryAt"`);
    await queryRunner.query(`ALTER TABLE "pre_screenings" DROP COLUMN "generationAttempts"`);
    await queryRunner.query(`ALTER TABLE "pre_screenings" DROP COLUMN "generationStatus"`);
    await queryRunner.query(`DROP TYPE "public"."pre_screenings_generationstatus_enum"`);

    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "cvEmbeddingLastError"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "cvEmbeddingLockedAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "cvEmbeddingNextRetryAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "cvEmbeddingAttempts"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "cvEmbeddingStatus"`);
    await queryRunner.query(`DROP TYPE "public"."users_cvembeddingstatus_enum"`);

    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "matchVerdictLastError"`);
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "matchVerdictLockedAt"`);
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "matchVerdictNextRetryAt"`);
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "matchVerdictAttempts"`);
  }
}
