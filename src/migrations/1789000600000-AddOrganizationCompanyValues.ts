import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrganizationCompanyValues1789000600000 implements MigrationInterface {
  name = "AddOrganizationCompanyValues1789000600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "company_values" jsonb NOT NULL DEFAULT '[]'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "company_values"`);
  }
}
