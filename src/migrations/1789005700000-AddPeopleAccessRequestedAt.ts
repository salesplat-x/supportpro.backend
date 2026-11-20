import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPeopleAccessRequestedAt1789005700000 implements MigrationInterface {
  name = "AddPeopleAccessRequestedAt1789005700000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organization_members" ADD "people_access_requested_at" TIMESTAMP WITH TIME ZONE`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organization_members" DROP COLUMN "people_access_requested_at"`
    );
  }
}
