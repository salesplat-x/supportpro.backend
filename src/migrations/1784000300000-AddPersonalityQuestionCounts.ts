import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPersonalityQuestionCounts1784000300000 implements MigrationInterface {
  name = "AddPersonalityQuestionCounts1784000300000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ADD "noOfEIQuestions" integer NOT NULL DEFAULT 3`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ADD "noOfSNQuestions" integer NOT NULL DEFAULT 3`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ADD "noOfTFQuestions" integer NOT NULL DEFAULT 3`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ADD "noOfJPQuestions" integer NOT NULL DEFAULT 3`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_configs" DROP COLUMN "noOfJPQuestions"`);
    await queryRunner.query(`ALTER TABLE "ai_configs" DROP COLUMN "noOfTFQuestions"`);
    await queryRunner.query(`ALTER TABLE "ai_configs" DROP COLUMN "noOfSNQuestions"`);
    await queryRunner.query(`ALTER TABLE "ai_configs" DROP COLUMN "noOfEIQuestions"`);
  }
}
