import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrganizationDomain1787900000000 implements MigrationInterface {
  name = "AddOrganizationDomain1787900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organizations"
      ADD COLUMN IF NOT EXISTS "domain" character varying
    `);

    await queryRunner.query(`
      UPDATE "organizations"
      SET "domain" = LOWER(SPLIT_PART("email", '@', 2))
      WHERE "domain" IS NULL AND "email" IS NOT NULL AND "email" LIKE '%@%'
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_organizations_domain_unique"
      ON "organizations" ("domain")
      WHERE "domain" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_organizations_domain_unique"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN IF EXISTS "domain"`);
  }
}
