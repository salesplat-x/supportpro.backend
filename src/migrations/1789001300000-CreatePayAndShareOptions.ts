import { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePayAndShareOptions1789001300000 implements MigrationInterface {
  name = "CreatePayAndShareOptions1789001300000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "benefits" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "name" character varying(120) NOT NULL,
        "description" character varying(500),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_benefits_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_benefits_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_benefits_org_name" ON "benefits" ("organization_id", "name")`
    );

    await queryRunner.query(`
      CREATE TABLE "pay_packages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "staff_id" uuid NOT NULL,
        "currency" character varying(3) NOT NULL,
        "period" character varying(16) NOT NULL,
        "base_salary" numeric(14,2) NOT NULL,
        "bonus" numeric(14,2) NOT NULL DEFAULT '0',
        "commission_target" numeric(14,2) NOT NULL DEFAULT '0',
        "starts_on" date NOT NULL,
        "created_by_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_pay_packages_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_pay_packages_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_pay_packages_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_pay_packages_staff_starts_on" ON "pay_packages" ("staff_id", "starts_on")`
    );

    await queryRunner.query(`
      CREATE TABLE "pay_package_benefits" (
        "pay_package_id" uuid NOT NULL,
        "benefit_id" uuid NOT NULL,
        CONSTRAINT "PK_pay_package_benefits" PRIMARY KEY ("pay_package_id", "benefit_id"),
        CONSTRAINT "FK_pay_package_benefits_package" FOREIGN KEY ("pay_package_id")
          REFERENCES "pay_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_pay_package_benefits_benefit" FOREIGN KEY ("benefit_id")
          REFERENCES "benefits"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_bf75a73d685e129422464fca6c" ON "pay_package_benefits" ("pay_package_id")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d2957899465ea7ee6ccfd9fb34" ON "pay_package_benefits" ("benefit_id")`
    );

    await queryRunner.query(`
      CREATE TABLE "share_grants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "staff_id" uuid NOT NULL,
        "shares" integer NOT NULL,
        "granted_on" date NOT NULL,
        "cliff_months" integer NOT NULL,
        "vesting_months" integer NOT NULL,
        "strike_price" numeric(14,2) NOT NULL,
        "currency" character varying(3) NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_share_grants_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_share_grants_shares_positive" CHECK ("shares" > 0),
        CONSTRAINT "CHK_share_grants_schedule"
          CHECK ("vesting_months" >= 1 AND "cliff_months" >= 0 AND "cliff_months" <= "vesting_months"),
        CONSTRAINT "FK_share_grants_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_share_grants_staff" ON "share_grants" ("staff_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "share_grants"`);
    await queryRunner.query(`DROP TABLE "pay_package_benefits"`);
    await queryRunner.query(`DROP TABLE "pay_packages"`);
    await queryRunner.query(`DROP TABLE "benefits"`);
  }
}
