import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSourceToApplications1789002950000 implements MigrationInterface {
  name = "AddSourceToApplications1789002950000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" ADD "source" character varying(50)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "source"`);
  }
}
