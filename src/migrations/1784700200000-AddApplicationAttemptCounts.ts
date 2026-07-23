import { MigrationInterface, QueryRunner } from "typeorm";

export class AddApplicationAttemptCounts1784700200000 implements MigrationInterface {
  name = "AddApplicationAttemptCounts1784700200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "cvSimilarityAttempts" integer NOT NULL DEFAULT 0`
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "personalizedAttempts" integer NOT NULL DEFAULT 0`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "personalizedAttempts"`);
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "cvSimilarityAttempts"`);
  }
}
