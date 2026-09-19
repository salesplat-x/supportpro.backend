import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSpacesAvatarAndCvColumns1788100000000 implements MigrationInterface {
  name = "AddSpacesAvatarAndCvColumns1788100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "profileImageUrl" character varying`);
    await queryRunner.query(`ALTER TABLE "users" ADD "profileImageKey" character varying`);
    await queryRunner.query(`ALTER TABLE "users" ADD "cvUrl" character varying`);
    await queryRunner.query(`ALTER TABLE "users" ADD "cvKey" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "cvKey"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "cvUrl"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "profileImageKey"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "profileImageUrl"`);
  }
}
