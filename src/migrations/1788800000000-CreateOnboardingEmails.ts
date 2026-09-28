import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateOnboardingEmails1788800000000 implements MigrationInterface {
  name = "CreateOnboardingEmails1788800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "onboarding_emails" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "sent_by_id" uuid,
        "stage" character varying(32) NOT NULL,
        "subject" character varying(200) NOT NULL,
        "body" text NOT NULL,
        "status" character varying(16) NOT NULL,
        "error" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_onboarding_emails_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ea0ff6c657dba9b1530fe8ff381" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_0ddc546ffab3e7832244d4a92c0" FOREIGN KEY ("sent_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_onboarding_emails_user_created" ON "onboarding_emails" ("user_id", "created_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_onboarding_emails_user_created"`);
    await queryRunner.query(`DROP TABLE "onboarding_emails"`);
  }
}
