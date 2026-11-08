import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateApplicationConsents1789005000000 implements MigrationInterface {
  name = "CreateApplicationConsents1789005000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "application_consents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "application_id" uuid NOT NULL,
        "talent_id" uuid NOT NULL,
        "version" character varying(32) NOT NULL,
        "agreed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_application_consents_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_application_consents_application" FOREIGN KEY ("application_id")
          REFERENCES "applications"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_application_consents_talent" FOREIGN KEY ("talent_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_application_consents_application" ON "application_consents" ("application_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "application_consents"`);
  }
}
