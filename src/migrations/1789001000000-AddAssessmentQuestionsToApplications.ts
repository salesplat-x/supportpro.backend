import { MigrationInterface, QueryRunner } from "typeorm";

// Day 4: which problem-solving and culture-fit questions each applicant was
// given, so they see the same set every time they come back.
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
