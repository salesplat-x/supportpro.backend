import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCvTextAndFileNameToUsers1784701000000 implements MigrationInterface {
  name = "AddCvTextAndFileNameToUsers1784701000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "cvFileName" character varying`);
    await queryRunner.query(`ALTER TABLE "users" ADD "cvText" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "cvText"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "cvFileName"`);
  }
}
