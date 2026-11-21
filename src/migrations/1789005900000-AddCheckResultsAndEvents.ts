import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCheckResultsAndEvents1789005900000 implements MigrationInterface {
  name = "AddCheckResultsAndEvents1789005900000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "application_checks"
        ADD COLUMN "confirmed_by" character varying(160),
        ADD COLUMN "confirmed_on" date,
        ADD COLUMN "note" text,
        ADD COLUMN "name_on_id" character varying(200),
        ADD COLUMN "name_given" character varying(200),
        ADD COLUMN "completed_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      CREATE TABLE "application_check_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "application_id" uuid NOT NULL,
        "check_id" uuid NOT NULL,
        "actor_id" uuid,
        "kind" character varying(24) NOT NULL,
        "detail" character varying(64),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_application_check_events_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_application_check_events_application" FOREIGN KEY ("application_id")
          REFERENCES "applications"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_application_check_events_check" FOREIGN KEY ("check_id")
          REFERENCES "application_checks"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_application_check_events_actor" FOREIGN KEY ("actor_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_application_check_events_check" ON "application_check_events" ("check_id", "created_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "application_check_events"`);
    await queryRunner.query(`
      ALTER TABLE "application_checks"
        DROP COLUMN "completed_at",
        DROP COLUMN "name_given",
        DROP COLUMN "name_on_id",
        DROP COLUMN "note",
        DROP COLUMN "confirmed_on",
        DROP COLUMN "confirmed_by"
    `);
  }
}
