import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateOrganizationOwnershipTransfers1789002600000 implements MigrationInterface {
  name = "CreateOrganizationOwnershipTransfers1789002600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "organization_ownership_transfers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "from_user_id" uuid,
        "to_user_id" uuid,
        "admin_id" uuid,
        "from_name" character varying(241) NOT NULL,
        "to_name" character varying(241) NOT NULL,
        "reason" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_organization_ownership_transfers" PRIMARY KEY ("id"),
        CONSTRAINT "FK_organization_ownership_transfers_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_organization_ownership_transfers_from" FOREIGN KEY ("from_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_organization_ownership_transfers_to" FOREIGN KEY ("to_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_organization_ownership_transfers_admin" FOREIGN KEY ("admin_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_organization_ownership_transfers_org"
        ON "organization_ownership_transfers" ("organization_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "organization_ownership_transfers"`);
  }
}
