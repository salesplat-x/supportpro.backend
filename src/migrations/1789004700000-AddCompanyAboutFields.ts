import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCompanyAboutFields1789004700000 implements MigrationInterface {
  name = "AddCompanyAboutFields1789004700000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "company_values_text" text DEFAULT NULL`
    );
    await queryRunner.query(`ALTER TABLE "organizations" ADD "size" character varying(16)`);
    await queryRunner.query(`ALTER TABLE "organizations" ADD "about" text DEFAULT NULL`);
    await queryRunner.query(`ALTER TABLE "organizations" ADD "founded_year" integer DEFAULT NULL`);
    await queryRunner.query(
      `UPDATE "organizations" o SET "company_values_text" = (
         SELECT string_agg(regexp_replace(btrim(v), '[.!?]+$', ''), '. ' ORDER BY i) || '.'
         FROM jsonb_array_elements_text(o."company_values") WITH ORDINALITY AS t(v, i)
         WHERE btrim(v) <> ''
       )
       WHERE jsonb_array_length(o."company_values") > 0`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "founded_year"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "about"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "size"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "company_values_text"`);
  }
}
