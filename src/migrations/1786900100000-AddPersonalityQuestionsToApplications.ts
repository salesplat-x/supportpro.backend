import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPersonalityQuestionsToApplications1786900100000 implements MigrationInterface {
  name = "AddPersonalityQuestionsToApplications1786900100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" ADD "personalityQuestions" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "personalityQuestions"`);
  }
}
