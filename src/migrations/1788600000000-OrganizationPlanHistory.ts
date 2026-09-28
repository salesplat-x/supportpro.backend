import { MigrationInterface, QueryRunner } from "typeorm";

export class OrganizationPlanHistory1788600000000 implements MigrationInterface {
  name = "OrganizationPlanHistory1788600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "organization_plan_history" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "from_plan" character varying(64),
        "to_plan" character varying(64) NOT NULL,
        "billing_interval" "public"."plans_interval_enum",
        "reason" character varying(32) NOT NULL,
        "payment_id" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_organization_plan_history" PRIMARY KEY ("id"),
        CONSTRAINT "FK_e55a396822dd80ccdc382d052ef" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_organization_plan_history_org_created"
      ON "organization_plan_history" ("organization_id", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "organization_plan_history"`);
  }
}
