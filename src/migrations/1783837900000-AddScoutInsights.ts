import { MigrationInterface, QueryRunner } from "typeorm";

export class AddScoutInsights1783837900000 implements MigrationInterface {
  name = "AddScoutInsights1783837900000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "insights" text`);
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "coverLetterInsights" text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "scouts" DROP COLUMN "coverLetterInsights"`);
    await queryRunner.query(`ALTER TABLE "scouts" DROP COLUMN "insights"`);
  }
}
