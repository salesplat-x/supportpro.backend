import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTalentCvReader1789003000000 implements MigrationInterface {
  name = "AddTalentCvReader1789003000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD "cv_skills" jsonb,
        ADD "cv_years_experience" integer,
        ADD "cv_parse_status" character varying(16)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN "cv_parse_status",
        DROP COLUMN "cv_years_experience",
        DROP COLUMN "cv_skills"
    `);
  }
}
