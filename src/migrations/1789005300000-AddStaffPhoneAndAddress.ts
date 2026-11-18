import { MigrationInterface, QueryRunner } from "typeorm";

export class AddStaffPhoneAndAddress1789005300000 implements MigrationInterface {
  name = "AddStaffPhoneAndAddress1789005300000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "staff_members" ADD "phone" character varying(40)`);
    await queryRunner.query(
      `ALTER TABLE "staff_members" ADD "home_address" character varying(300)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "staff_members" DROP COLUMN "home_address"`);
    await queryRunner.query(`ALTER TABLE "staff_members" DROP COLUMN "phone"`);
  }
}
