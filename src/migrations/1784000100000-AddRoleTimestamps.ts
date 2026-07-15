import { MigrationInterface, QueryRunner } from "typeorm";

export class AddRoleTimestamps1784000100000 implements MigrationInterface {
  name = "AddRoleTimestamps1784000100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "roles" ADD "createdAt" TIMESTAMP NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "roles" ADD "updatedAt" TIMESTAMP NOT NULL DEFAULT now()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "updatedAt"`);
    await queryRunner.query(`ALTER TABLE "roles" DROP COLUMN "createdAt"`);
  }
}
