import { MigrationInterface, QueryRunner } from "typeorm";

export class RemoveUserPhone1787100000000 implements MigrationInterface {
  name = "RemoveUserPhone1787100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "phone"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" character varying`);
  }
}
