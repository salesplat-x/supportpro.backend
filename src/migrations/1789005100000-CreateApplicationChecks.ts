import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateApplicationChecks1789005100000 implements MigrationInterface {
  name = "CreateApplicationChecks1789005100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "application_checks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "application_id" uuid NOT NULL,
        "ordered_by_id" uuid NOT NULL,
        "type" character varying(16) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "result_text" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_application_checks_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_application_checks_application" FOREIGN KEY ("application_id")
          REFERENCES "applications"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_application_checks_ordered_by" FOREIGN KEY ("ordered_by_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_application_checks_application" ON "application_checks" ("application_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "application_checks"`);
  }
}
