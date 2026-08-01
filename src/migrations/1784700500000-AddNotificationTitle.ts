import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNotificationTitle1784700500000 implements MigrationInterface {
  name = "AddNotificationTitle1784700500000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notifications" ADD "title" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN "title"`);
  }
}
