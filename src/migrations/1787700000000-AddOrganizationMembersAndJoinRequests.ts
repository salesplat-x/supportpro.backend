import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrganizationMembersAndJoinRequests1787700000000 implements MigrationInterface {
  name = "AddOrganizationMembersAndJoinRequests1787700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "organization_members" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "organization_id" uuid NOT NULL,
        "work_email" character varying NOT NULL,
        "role" character varying NOT NULL DEFAULT 'member',
        "verified_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_organization_members_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_org_members_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_org_members_org" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_org_members_user_org" ON "organization_members" ("user_id", "organization_id")
    `);

    await queryRunner.query(`
      CREATE TABLE "organization_join_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "organization_id" uuid NOT NULL,
        "work_email" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_organization_join_requests_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_org_join_requests_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_org_join_requests_org" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_org_join_requests_user_org" ON "organization_join_requests" ("user_id", "organization_id")
    `);

    // Backfill owner membership for existing organizations
    await queryRunner.query(`
      INSERT INTO "organization_members" ("user_id", "organization_id", "work_email", "role", "verified_at")
      SELECT o."owner_id", o."id", COALESCE(o."email", u."email"), 'owner', COALESCE(o."verified_at", NOW())
      FROM "organizations" o
      JOIN "users" u ON u."id" = o."owner_id"
      WHERE o."owner_id" IS NOT NULL
      ON CONFLICT ("user_id", "organization_id") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_org_join_requests_user_org"`);
    await queryRunner.query(`DROP TABLE "organization_join_requests"`);
    await queryRunner.query(`DROP INDEX "idx_org_members_user_org"`);
    await queryRunner.query(`DROP TABLE "organization_members"`);
  }
}
