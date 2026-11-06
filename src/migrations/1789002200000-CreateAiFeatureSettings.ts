import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAiFeatureSettings1789002200000 implements MigrationInterface {
  name = "CreateAiFeatureSettings1789002200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_feature_settings" (
        "feature_key" character varying(64) NOT NULL,
        "provider" character varying(32),
        "model" character varying(128),
        "prompts" jsonb NOT NULL DEFAULT '{}',
        "updated_by_id" uuid,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_feature_settings" PRIMARY KEY ("feature_key"),
        CONSTRAINT "FK_ai_feature_settings_updated_by" FOREIGN KEY ("updated_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ai_feature_settings"`);
  }
}
