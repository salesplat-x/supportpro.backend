import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrganizationLogoKey1788200000000 implements MigrationInterface {
  name = "AddOrganizationLogoKey1788200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" ADD "logo_key" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "logo_key"`);
  }
}
