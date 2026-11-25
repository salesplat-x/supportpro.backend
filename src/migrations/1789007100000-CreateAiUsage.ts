import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAiUsage1789007100000 implements MigrationInterface {
  name = "CreateAiUsage1789007100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_usage_daily" (
        "day" date NOT NULL,
        "provider" character varying(32) NOT NULL,
        "model" character varying(100) NOT NULL,
        "feature" character varying(64) NOT NULL,
        "calls" integer NOT NULL DEFAULT '0',
        "failed_calls" integer NOT NULL DEFAULT '0',
        "credit_failures" integer NOT NULL DEFAULT '0',
        "input_tokens" bigint NOT NULL DEFAULT '0',
        "output_tokens" bigint NOT NULL DEFAULT '0',
        "characters" bigint NOT NULL DEFAULT '0',
        "audio_seconds" numeric(14,2) NOT NULL DEFAULT '0',
        CONSTRAINT "PK_ai_usage_daily" PRIMARY KEY ("day", "provider", "model", "feature")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "ai_provider_status" (
        "provider" character varying(32) NOT NULL,
        "out_of_credit_since" TIMESTAMP WITH TIME ZONE,
        "credit_error" character varying(64),
        "balance" numeric(16,4),
        "balance_unit" character varying(16),
        "balance_checked_at" TIMESTAMP WITH TIME ZONE,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_provider_status" PRIMARY KEY ("provider")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ai_provider_status"`);
    await queryRunner.query(`DROP TABLE "ai_usage_daily"`);
  }
}
