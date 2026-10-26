import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMemberCanManagePeople1789000500000 implements MigrationInterface {
  name = "AddMemberCanManagePeople1789000500000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organization_members" ADD "can_manage_people" boolean NOT NULL DEFAULT false`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization_members" DROP COLUMN "can_manage_people"`);
  }
}
