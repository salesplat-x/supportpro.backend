import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateApplicationReferences1789004000000 implements MigrationInterface {
  name = "CreateApplicationReferences1789004000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "application_references" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "application_id" uuid NOT NULL,
        "job_id" uuid NOT NULL,
        "talent_id" uuid NOT NULL,
        "name" character varying(120) NOT NULL,
        "email" character varying(255) NOT NULL,
        "relationship" character varying(120) NOT NULL,
        "token_hash" character varying(64) NOT NULL,
        "token_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "sent_at" TIMESTAMP WITH TIME ZONE,
        "answered_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_application_references_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_application_references_application" FOREIGN KEY ("application_id")
          REFERENCES "applications"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_application_references_job" FOREIGN KEY ("job_id")
          REFERENCES "jobs"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_application_references_talent" FOREIGN KEY ("talent_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_application_references_email" ON "application_references" ("application_id", "email")`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_application_references_token" ON "application_references" ("token_hash")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "application_references"`);
  }
}
