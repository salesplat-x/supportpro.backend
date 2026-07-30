import { MigrationInterface, QueryRunner } from "typeorm";

export class ScoutDataIntegrityCleanup1784700400000 implements MigrationInterface {
  name = "ScoutDataIntegrityCleanup1784700400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // batch_embedding was never read or written by any code path — confirmed dead column.
    await queryRunner.query(`ALTER TABLE "scouts" DROP COLUMN IF EXISTS "batch_embedding"`);

    // cv_text_hash: dedup key (SHA-256 of extracted CV text) used to skip redundant LLM
    // scoring when the exact same CV is re-uploaded for the same job/recruiter.
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "cv_text_hash" character varying`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_7cefee52a9cdfee609d15eb142" ON "scouts" ("cv_text_hash")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_7cefee52a9cdfee609d15eb142"`);
    await queryRunner.query(`ALTER TABLE "scouts" DROP COLUMN IF EXISTS "cv_text_hash"`);
    await queryRunner.query(`ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "batch_embedding" text`);
    await queryRunner.query(`ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "batch_embedding" text`);
  }
}
