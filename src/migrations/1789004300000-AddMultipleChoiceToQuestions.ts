import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMultipleChoiceToQuestions1789004300000 implements MigrationInterface {
  name = "AddMultipleChoiceToQuestions1789004300000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "questions" ADD "options" jsonb`);
    await queryRunner.query(`ALTER TABLE "questions" ADD "correctOption" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "questions" DROP COLUMN "correctOption"`);
    await queryRunner.query(`ALTER TABLE "questions" DROP COLUMN "options"`);
  }
}
