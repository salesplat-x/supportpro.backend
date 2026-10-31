import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCommissionAndDocuments1789001400000 implements MigrationInterface {
  name = "CreateCommissionAndDocuments1789001400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "commission_plans" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "name" character varying(120) NOT NULL,
        "tiers" jsonb NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_commission_plans_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_commission_plans_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_commission_plans_org_name" ON "commission_plans" ("organization_id", "name")`
    );
    await queryRunner.query(`ALTER TABLE "pay_packages" ADD "commission_plan_id" uuid`);
    await queryRunner.query(`
      ALTER TABLE "pay_packages" ADD CONSTRAINT "FK_pay_packages_commission_plan"
      FOREIGN KEY ("commission_plan_id") REFERENCES "commission_plans"("id") ON DELETE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "staff_documents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "staff_id" uuid NOT NULL,
        "template" character varying(32) NOT NULL,
        "title" character varying(120) NOT NULL,
        "body_text" text NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'sent',
        "token_hash" character varying(64),
        "token_expires_at" TIMESTAMP,
        "sent_by_id" uuid,
        "sent_at" TIMESTAMP NOT NULL,
        "opened_at" TIMESTAMP,
        "signed_at" TIMESTAMP,
        "signer_name" character varying(120),
        "signer_ip" character varying(64),
        "check_code" character varying(64),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_documents_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_staff_documents_signed" CHECK (("status" = 'signed') = ("signed_at" IS NOT NULL)),
        CONSTRAINT "FK_staff_documents_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_documents_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_documents_sent_by" FOREIGN KEY ("sent_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_documents_staff" ON "staff_documents" ("staff_id", "sent_at")`
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_staff_documents_staff_template_sent"
      ON "staff_documents" ("staff_id", "template") WHERE "status" = 'sent'
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_staff_documents_token_hash" ON "staff_documents" ("token_hash")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "staff_documents"`);
    await queryRunner.query(
      `ALTER TABLE "pay_packages" DROP CONSTRAINT "FK_pay_packages_commission_plan"`
    );
    await queryRunner.query(`ALTER TABLE "pay_packages" DROP COLUMN "commission_plan_id"`);
    await queryRunner.query(`DROP TABLE "commission_plans"`);
  }
}
