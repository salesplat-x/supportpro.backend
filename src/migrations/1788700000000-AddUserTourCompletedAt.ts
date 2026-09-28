import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserTourCompletedAt1788700000000 implements MigrationInterface {
  name = "AddUserTourCompletedAt1788700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "tour_completed_at" TIMESTAMP DEFAULT NULL`);
    // The tour is for first-time users only — people already using the app skip it.
    await queryRunner.query(`UPDATE "users" SET "tour_completed_at" = NOW()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "tour_completed_at"`);
  }
}
