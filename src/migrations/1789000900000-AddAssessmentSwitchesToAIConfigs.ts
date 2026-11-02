import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAssessmentSwitchesToAIConfigs1789000900000 implements MigrationInterface {
  name = "AddAssessmentSwitchesToAIConfigs1789000900000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ADD "problemSolvingAssessment" boolean NOT NULL DEFAULT false`
    );
    await queryRunner.query(`ALTER TABLE "ai_configs" ADD "noOfProblemSolvingQuestions" integer`);
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ADD "cultureFitAssessment" boolean NOT NULL DEFAULT false`
    );
    await queryRunner.query(`ALTER TABLE "ai_configs" ADD "noOfCultureFitQuestions" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_configs" DROP COLUMN "noOfCultureFitQuestions"`);
    await queryRunner.query(`ALTER TABLE "ai_configs" DROP COLUMN "cultureFitAssessment"`);
    await queryRunner.query(`ALTER TABLE "ai_configs" DROP COLUMN "noOfProblemSolvingQuestions"`);
    await queryRunner.query(`ALTER TABLE "ai_configs" DROP COLUMN "problemSolvingAssessment"`);
  }
}
