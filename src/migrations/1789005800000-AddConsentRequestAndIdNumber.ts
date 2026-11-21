import { MigrationInterface, QueryRunner } from "typeorm";

export class AddConsentRequestAndIdNumber1789005800000 implements MigrationInterface {
  name = "AddConsentRequestAndIdNumber1789005800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "application_consents"
        ALTER COLUMN "version" DROP NOT NULL,
        ALTER COLUMN "agreed_at" DROP NOT NULL,
        ADD COLUMN "requested_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "declined_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "id_kind" character varying(3),
        ADD COLUMN "id_number_encrypted" text,
        ADD COLUMN "id_number_last4" character varying(4)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "application_consents" WHERE "agreed_at" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "application_consents"
        DROP COLUMN "id_number_last4",
        DROP COLUMN "id_number_encrypted",
        DROP COLUMN "id_kind",
        DROP COLUMN "declined_at",
        DROP COLUMN "requested_at",
        ALTER COLUMN "agreed_at" SET NOT NULL,
        ALTER COLUMN "version" SET NOT NULL
    `);
  }
}
