import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAiSkillSettings1789006900000 implements MigrationInterface {
  name = "CreateAiSkillSettings1789006900000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_skill_settings" (
        "skill_key" character varying(64) NOT NULL,
        "text" text NOT NULL,
        "updated_by_id" uuid,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_skill_settings" PRIMARY KEY ("skill_key"),
        CONSTRAINT "FK_ai_skill_settings_updated_by" FOREIGN KEY ("updated_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ai_skill_settings"`);
  }
}
