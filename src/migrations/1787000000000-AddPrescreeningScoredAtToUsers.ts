import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPrescreeningScoredAtToUsers1787000000000 implements MigrationInterface {
  name = "AddPrescreeningScoredAtToUsers1787000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "prescreeningScoredAt" TIMESTAMP DEFAULT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "prescreeningScoredAt"`);
  }
}
