import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrganizationInvites1787800000000 implements MigrationInterface {
  name = "AddOrganizationInvites1787800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "organization_invites" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "email" character varying NOT NULL,
        "token" character varying NOT NULL,
        "invited_by_id" uuid NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "expires_at" TIMESTAMP NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_organization_invites_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_org_invites_org" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_org_invites_invited_by" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_org_invites_token" ON "organization_invites" ("token")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_org_invites_org_email" ON "organization_invites" ("organization_id", "email")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_org_invites_org_email"`);
    await queryRunner.query(`DROP INDEX "idx_org_invites_token"`);
    await queryRunner.query(`DROP TABLE "organization_invites"`);
  }
}
