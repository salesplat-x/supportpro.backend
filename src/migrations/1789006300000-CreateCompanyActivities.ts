import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCompanyActivities1789006300000 implements MigrationInterface {
  name = "CreateCompanyActivities1789006300000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "company_activities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "actor_id" uuid,
        "actor_name" character varying(241) NOT NULL,
        "action" character varying(120) NOT NULL,
        "method" character varying(8) NOT NULL,
        "route" character varying(255) NOT NULL,
        "target_type" character varying(40),
        "target_id" character varying(64),
        "target_label" character varying(241),
        "changed_fields" jsonb NOT NULL DEFAULT '[]',
        "ip" character varying(64),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_company_activities_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_company_activities_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_company_activities_actor" FOREIGN KEY ("actor_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_company_activities_org_created" ON "company_activities" ("organization_id", "created_at")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_company_activities_org_actor_created" ON "company_activities" ("organization_id", "actor_id", "created_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "company_activities"`);
  }
}
