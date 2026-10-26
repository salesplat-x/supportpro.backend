import { MigrationInterface, QueryRunner } from "typeorm";

// Day 8: a company's switch for its public Indeed XML job feed. Off by default.
export class AddIndeedFeedSwitchToOrganizations1789001300000 implements MigrationInterface {
  name = "AddIndeedFeedSwitchToOrganizations1789001300000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "indeed_feed_enabled" boolean NOT NULL DEFAULT false`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "indeed_feed_enabled"`);
  }
}
