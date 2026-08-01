import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMatchVerdictEvidence1784700600000 implements MigrationInterface {
  name = "AddMatchVerdictEvidence1784700600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."applications_matchrecommendation_enum" AS ENUM('hire', 'interview_further', 'no_hire')`
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "matchRecommendation" "public"."applications_matchrecommendation_enum"`
    );
    await queryRunner.query(`ALTER TABLE "applications" ADD "matchStrengths" jsonb`);
    await queryRunner.query(`ALTER TABLE "applications" ADD "matchWeaknesses" jsonb`);
    await queryRunner.query(`ALTER TABLE "applications" ADD "matchRisks" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "matchRisks"`);
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "matchWeaknesses"`);
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "matchStrengths"`);
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "matchRecommendation"`);
    await queryRunner.query(`DROP TYPE "public"."applications_matchrecommendation_enum"`);
  }
}
