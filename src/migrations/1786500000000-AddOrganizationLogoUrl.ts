import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrganizationLogoUrl1786500000000 implements MigrationInterface {
  name = "AddOrganizationLogoUrl1786500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" ADD "logo_url" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "logo_url"`);
  }
}
