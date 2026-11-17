import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrganizationMemberTitle1789004900000 implements MigrationInterface {
  name = "AddOrganizationMemberTitle1789004900000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization_members" ADD "title" character varying(60)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization_members" DROP COLUMN "title"`);
  }
}
