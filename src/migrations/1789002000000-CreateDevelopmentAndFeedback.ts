import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDevelopmentAndFeedback1789002000000 implements MigrationInterface {
  name = "CreateDevelopmentAndFeedback1789002000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "staff_development_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "staff_id" uuid NOT NULL,
        "weak_area" character varying(200) NOT NULL,
        "action" character varying(1000) NOT NULL,
        "due_on" date,
        "status" character varying(16) NOT NULL DEFAULT 'open',
        "source" character varying(16) NOT NULL DEFAULT 'manual',
        "source_ref" character varying(200),
        "version" integer NOT NULL DEFAULT 1,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_development_items_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_staff_development_items_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_development_items_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_development_items_staff" ON "staff_development_items" ("staff_id", "status")`
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_staff_development_items_source"
        ON "staff_development_items" ("staff_id", "source", "source_ref")
        WHERE "source_ref" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TABLE "staff_monthly_feedback" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "staff_id" uuid NOT NULL,
        "month" date NOT NULL,
        "rating" smallint NOT NULL,
        "notes" text NOT NULL,
        "by_name" character varying(241) NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_staff_monthly_feedback_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_staff_monthly_feedback_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_monthly_feedback_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_staff_monthly_feedback_rating" CHECK ("rating" BETWEEN 1 AND 5)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_staff_monthly_feedback_staff_month" ON "staff_monthly_feedback" ("staff_id", "month")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "staff_monthly_feedback"`);
    await queryRunner.query(`DROP TABLE "staff_development_items"`);
  }
}
