import { MigrationInterface, QueryRunner } from "typeorm";

export class MakeJobLocationCountryNullable1787400000000 implements MigrationInterface {
  name = "MakeJobLocationCountryNullable1787400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "locationCountry" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "jobs" SET "locationCountry" = '' WHERE "locationCountry" IS NULL`
    );
    await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "locationCountry" SET NOT NULL`);
  }
}
