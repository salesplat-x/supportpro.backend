import { MigrationInterface, QueryRunner } from "typeorm";

export class AddIndeedFeedSwitchToOrganizations1789001600000 implements MigrationInterface {
  name = "AddIndeedFeedSwitchToOrganizations1789001600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "indeed_feed_enabled" boolean NOT NULL DEFAULT false`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "indeed_feed_enabled"`);
  }
}
