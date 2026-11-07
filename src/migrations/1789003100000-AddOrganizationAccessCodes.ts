import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrganizationAccessCodes1789003100000 implements MigrationInterface {
  name = "AddOrganizationAccessCodes1789003100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" ADD "access_code" character varying(9)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_organizations_access_code_unique" ON "organizations" ("access_code") WHERE "access_code" IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_organizations_access_code_unique"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "access_code"`);
  }
}
