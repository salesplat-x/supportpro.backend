import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrganizationDepartments1789004800000 implements MigrationInterface {
  name = "AddOrganizationDepartments1789004800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "departments" jsonb NOT NULL DEFAULT '[]'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "departments"`);
  }
}
