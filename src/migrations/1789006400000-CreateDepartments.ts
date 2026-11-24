import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDepartments1789006400000 implements MigrationInterface {
  name = "CreateDepartments1789006400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "departments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "name" character varying(120) NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_departments_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_departments_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_departments_org_name" ON "departments" ("organization_id", "name")`
    );
    await queryRunner.query(`ALTER TABLE "staff_members" ADD "department_id" uuid`);
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_members_department" ON "staff_members" ("department_id")`
    );
    await queryRunner.query(`
      ALTER TABLE "staff_members" ADD CONSTRAINT "FK_staff_members_department"
        FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`
      INSERT INTO "departments" ("organization_id", "name")
      SELECT DISTINCT ON (src."organization_id", lower(src."name")) src."organization_id", src."name"
      FROM (
        SELECT o."id" AS "organization_id", btrim(d."name") AS "name", 0 AS "source", d."i" AS "ord"
        FROM "organizations" o,
          jsonb_array_elements_text(o."departments") WITH ORDINALITY AS d("name", "i")
        UNION ALL
        SELECT s."organization_id", btrim(s."department"), 1,
          (extract(epoch FROM s."created_at") * 1000)::bigint
        FROM "staff_members" s
        WHERE s."department" IS NOT NULL
      ) src
      WHERE src."name" <> ''
      ORDER BY src."organization_id", lower(src."name"), src."source", src."ord"
    `);
    await queryRunner.query(`
      UPDATE "staff_members" s
      SET "department_id" = d."id", "department" = d."name"
      FROM "departments" d
      WHERE d."organization_id" = s."organization_id"
        AND lower(d."name") = lower(btrim(s."department"))
    `);
    await queryRunner.query(`
      UPDATE "organizations" o
      SET "departments" = o."departments" || (
        SELECT COALESCE(jsonb_agg(d."name" ORDER BY d."name"), '[]'::jsonb)
        FROM "departments" d
        WHERE d."organization_id" = o."id"
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(o."departments") AS e("name")
            WHERE lower(btrim(e."name")) = lower(d."name")
          )
      )
      WHERE EXISTS (SELECT 1 FROM "departments" d WHERE d."organization_id" = o."id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "staff_members" DROP CONSTRAINT "FK_staff_members_department"`
    );
    await queryRunner.query(`DROP INDEX "IDX_staff_members_department"`);
    await queryRunner.query(`ALTER TABLE "staff_members" DROP COLUMN "department_id"`);
    await queryRunner.query(`DROP TABLE "departments"`);
  }
}
