import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAiRecommendationAnalysis1787500000000 implements MigrationInterface {
  name = "AddAiRecommendationAnalysis1787500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_recommendations" ADD "analysis" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_recommendations" DROP COLUMN "analysis"`);
  }
}
