import { MigrationInterface, QueryRunner } from "typeorm";

export class RemovePersonalityQuestionDefault1784700000000 implements MigrationInterface {
  name = "RemovePersonalityQuestionDefault1784700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfEIQuestions" DROP NOT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfEIQuestions" DROP DEFAULT`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfSNQuestions" DROP NOT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfSNQuestions" DROP DEFAULT`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfTFQuestions" DROP NOT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfTFQuestions" DROP DEFAULT`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfJPQuestions" DROP NOT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfJPQuestions" DROP DEFAULT`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfJPQuestions" SET DEFAULT 3`
    );
    await queryRunner.query(
      `UPDATE "ai_configs" SET "noOfJPQuestions" = 3 WHERE "noOfJPQuestions" IS NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfJPQuestions" SET NOT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfTFQuestions" SET DEFAULT 3`
    );
    await queryRunner.query(
      `UPDATE "ai_configs" SET "noOfTFQuestions" = 3 WHERE "noOfTFQuestions" IS NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfTFQuestions" SET NOT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfSNQuestions" SET DEFAULT 3`
    );
    await queryRunner.query(
      `UPDATE "ai_configs" SET "noOfSNQuestions" = 3 WHERE "noOfSNQuestions" IS NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfSNQuestions" SET NOT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfEIQuestions" SET DEFAULT 3`
    );
    await queryRunner.query(
      `UPDATE "ai_configs" SET "noOfEIQuestions" = 3 WHERE "noOfEIQuestions" IS NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "ai_configs" ALTER COLUMN "noOfEIQuestions" SET NOT NULL`
    );
  }
}
