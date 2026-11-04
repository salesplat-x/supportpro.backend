import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotificationLinks1789002300000 implements MigrationInterface {
  name = "AddNotificationLinks1789002300000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notifications"
        ADD "type" character varying(32),
        ADD "link" character varying(512),
        ADD "organization_id" uuid,
        ADD "dedupe_key" character varying(128)
    `);
    await queryRunner.query(`
      ALTER TABLE "notifications"
        ADD CONSTRAINT "FK_notifications_organization" FOREIGN KEY ("organization_id")
        REFERENCES "organizations"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_notifications_user_dedupe"
        ON "notifications" ("user_id", "dedupe_key") WHERE "dedupe_key" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_notifications_user_dedupe"`);
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP CONSTRAINT "FK_notifications_organization"`
    );
    await queryRunner.query(`
      ALTER TABLE "notifications"
        DROP COLUMN "dedupe_key",
        DROP COLUMN "organization_id",
        DROP COLUMN "link",
        DROP COLUMN "type"
    `);
  }
}
