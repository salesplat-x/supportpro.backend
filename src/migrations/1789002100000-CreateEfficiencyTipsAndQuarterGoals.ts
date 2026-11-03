import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateEfficiencyTipsAndQuarterGoals1789002100000 implements MigrationInterface {
  name = "CreateEfficiencyTipsAndQuarterGoals1789002100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "staff_efficiency_tips" (
        "staff_id" uuid NOT NULL,
        "inputs_hash" character varying(64) NOT NULL,
        "tip" text NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_staff_efficiency_tips_staff" PRIMARY KEY ("staff_id"),
        CONSTRAINT "FK_staff_efficiency_tips_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "company_quarter_goals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "quarter" character varying(7) NOT NULL,
        "currency" character varying(3) NOT NULL,
        "revenue_goal" numeric(16,2) NOT NULL,
        "revenue_so_far" numeric(16,2) NOT NULL DEFAULT 0,
        "version" integer NOT NULL DEFAULT 1,
        "updated_by_name" character varying(241) NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_company_quarter_goals_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_company_quarter_goals_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_company_quarter_goals_goal" CHECK ("revenue_goal" > 0),
        CONSTRAINT "CHK_company_quarter_goals_so_far" CHECK ("revenue_so_far" >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_company_quarter_goals_org_quarter" ON "company_quarter_goals" ("organization_id", "quarter")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "company_quarter_goals"`);
    await queryRunner.query(`DROP TABLE "staff_efficiency_tips"`);
  }
}
