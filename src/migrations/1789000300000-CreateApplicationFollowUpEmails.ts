import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateApplicationFollowUpEmails1789000300000 implements MigrationInterface {
  name = "CreateApplicationFollowUpEmails1789000300000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "application_follow_up_emails" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "application_id" uuid NOT NULL,
        "sent_by_id" uuid,
        "step" integer NOT NULL,
        "stage" character varying(32) NOT NULL,
        "application_updated_at_snapshot" TIMESTAMP NOT NULL,
        "subject" character varying(200) NOT NULL,
        "body" text NOT NULL,
        "status" character varying(16) NOT NULL,
        "error" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_application_follow_up_emails_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_app_follow_up_emails_app_step" UNIQUE ("application_id", "step"),
        CONSTRAINT "FK_0fc6c3b2ce3d9c148f5381d1084" FOREIGN KEY ("application_id")
          REFERENCES "applications"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_21ccafe8d9e98fa6a0d8345cd7a" FOREIGN KEY ("sent_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_app_follow_up_emails_app_created" ON "application_follow_up_emails" ("application_id", "created_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_app_follow_up_emails_app_created"`);
    await queryRunner.query(`DROP TABLE "application_follow_up_emails"`);
  }
}
