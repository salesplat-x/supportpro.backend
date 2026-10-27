import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAssessmentScoresToApplications1789001100000 implements MigrationInterface {
  name = "AddAssessmentScoresToApplications1789001100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "problemSolvingScore" double precision`
    );
    await queryRunner.query(`ALTER TABLE "applications" ADD "cultureFitScore" double precision`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "cultureFitScore"`);
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "problemSolvingScore"`);
  }
}
