import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrganizationJobFeed1789005000000 implements MigrationInterface {
  name = "AddOrganizationJobFeed1789005000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "indeed_feed_enabled" boolean NOT NULL DEFAULT false`
    );
    await queryRunner.query(`ALTER TABLE "organizations" ADD "feed_slug" character varying(80)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_organizations_feed_slug" ON "organizations" ("feed_slug")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_organizations_feed_slug"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "feed_slug"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "indeed_feed_enabled"`);
  }
}
