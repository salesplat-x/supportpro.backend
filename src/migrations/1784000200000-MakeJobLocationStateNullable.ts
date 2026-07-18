import { MigrationInterface, QueryRunner } from "typeorm";

export class MakeJobLocationStateNullable1784000200000 implements MigrationInterface {
  name = "MakeJobLocationStateNullable1784000200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "locationState" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "jobs" SET "locationState" = '' WHERE "locationState" IS NULL`);
    await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "locationState" SET NOT NULL`);
  }
}
