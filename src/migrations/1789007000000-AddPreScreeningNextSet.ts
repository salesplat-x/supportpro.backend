import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPreScreeningNextSet1789007000000 implements MigrationInterface {
  name = "AddPreScreeningNextSet1789007000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pre_screenings" ADD "nextQuestions" jsonb, ADD "nextRoles" text, ADD "nextGenerationStatus" character varying(16), ADD "nextGenerationAttempts" integer NOT NULL DEFAULT '0', ADD "nextGenerationNextRetryAt" TIMESTAMP, ADD "nextGenerationLockedAt" TIMESTAMP, ADD "nextGenerationLastError" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pre_screenings" DROP COLUMN "nextGenerationLastError", DROP COLUMN "nextGenerationLockedAt", DROP COLUMN "nextGenerationNextRetryAt", DROP COLUMN "nextGenerationAttempts", DROP COLUMN "nextGenerationStatus", DROP COLUMN "nextRoles", DROP COLUMN "nextQuestions"`
    );
  }
}
