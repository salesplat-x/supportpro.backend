import { MigrationInterface, QueryRunner } from "typeorm";

export class DropCloudinaryColumns1784701100000 implements MigrationInterface {
  name = "DropCloudinaryColumns1784701100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "profileImageUrl"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "profileImagePublicId"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "cvUrl"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "cvPublicId"`);
    await queryRunner.query(`ALTER TABLE "talent_embeddings" DROP COLUMN IF EXISTS "cv_public_id"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "talent_embeddings" ADD "cv_public_id" character varying`);
    await queryRunner.query(`ALTER TABLE "users" ADD "cvPublicId" character varying`);
    await queryRunner.query(`ALTER TABLE "users" ADD "cvUrl" character varying`);
    await queryRunner.query(`ALTER TABLE "users" ADD "profileImagePublicId" character varying`);
    await queryRunner.query(`ALTER TABLE "users" ADD "profileImageUrl" character varying`);
  }
}
