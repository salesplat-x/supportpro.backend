import { MigrationInterface, QueryRunner } from "typeorm";

export class AddShareGrantCreatedBy1789005500000 implements MigrationInterface {
  name = "AddShareGrantCreatedBy1789005500000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "share_grants" ADD "created_by_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "share_grants" ADD "created_by_name" character varying(241)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "share_grants" DROP COLUMN "created_by_name"`);
    await queryRunner.query(`ALTER TABLE "share_grants" DROP COLUMN "created_by_id"`);
  }
}
