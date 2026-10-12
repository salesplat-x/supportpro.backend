import { MigrationInterface, QueryRunner } from "typeorm";

export class DropUserTourCompletedAt1789000400000 implements MigrationInterface {
  name = "DropUserTourCompletedAt1789000400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "tour_completed_at"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "tour_completed_at" TIMESTAMP DEFAULT NULL`);
    await queryRunner.query(`UPDATE "users" SET "tour_completed_at" = NOW()`);
  }
}
