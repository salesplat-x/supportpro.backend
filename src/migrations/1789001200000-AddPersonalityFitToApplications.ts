import { MigrationInterface, QueryRunner } from "typeorm";

// Day 6: the AI's 0-100 judgement of how the applicant's personality (MBTI)
// fits the job, with its one-line reason. Empty until the MBTI type is saved.
export class AddPersonalityFitToApplications1789001200000 implements MigrationInterface {
  name = "AddPersonalityFitToApplications1789001200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "personalityFitScore" double precision`
    );
    await queryRunner.query(`ALTER TABLE "applications" ADD "personalityFitReason" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "personalityFitReason"`);
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "personalityFitScore"`);
  }
}
