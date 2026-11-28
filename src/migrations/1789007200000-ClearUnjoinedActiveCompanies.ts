import { MigrationInterface, QueryRunner } from "typeorm";

// Signup used to accept any user column, so an account could point at a company it never joined.
export class ClearUnjoinedActiveCompanies1789007200000 implements MigrationInterface {
  name = "ClearUnjoinedActiveCompanies1789007200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "users" u
      SET "active_organization_id" = NULL
      WHERE u."active_organization_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "organizations" o
          WHERE o."id" = u."active_organization_id" AND o."owner_id" = u."id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "organization_members" m
          WHERE m."user_id" = u."id" AND m."organization_id" = u."active_organization_id"
        )
    `);
  }

  public async down(): Promise<void> {}
}
