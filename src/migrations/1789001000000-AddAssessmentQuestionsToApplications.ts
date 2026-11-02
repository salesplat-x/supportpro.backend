import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAssessmentQuestionsToApplications1789001000000 implements MigrationInterface {
  name = "AddAssessmentQuestionsToApplications1789001000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" ADD "problemSolvingQuestions" text`);
    await queryRunner.query(`ALTER TABLE "applications" ADD "cultureFitQuestions" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "cultureFitQuestions"`);
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "problemSolvingQuestions"`);
  }
}
