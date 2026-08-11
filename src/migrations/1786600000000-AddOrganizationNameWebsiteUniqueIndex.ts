import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrganizationNameWebsiteUniqueIndex1786600000000 implements MigrationInterface {
  name = "AddOrganizationNameWebsiteUniqueIndex1786600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Two companies may share a name (e.g. "Acme") or a website, but not both at
    // once. NULL websites are excluded since Postgres already treats NULL as
    // distinct from every other NULL in a unique index.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_organizations_name_website"
      ON "organizations" (LOWER("name"), LOWER("website"))
      WHERE "website" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_organizations_name_website"`);
  }
}
