import { MigrationInterface, QueryRunner } from "typeorm";

export class AddStaffEndingOnAndReason1789005200000 implements MigrationInterface {
  name = "AddStaffEndingOnAndReason1789005200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "staff_members" ADD "ending_on" date`);
    await queryRunner.query(`ALTER TABLE "staff_members" ADD "end_reason" character varying(32)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "staff_members" DROP COLUMN "end_reason"`);
    await queryRunner.query(`ALTER TABLE "staff_members" DROP COLUMN "ending_on"`);
  }
}
