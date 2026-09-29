import { MigrationInterface, QueryRunner } from "typeorm";

export class AddApplicationOverallFitScore1788900000000 implements MigrationInterface {
  name = "AddApplicationOverallFitScore1788900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" ADD "overallFitScore" double precision`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "overallFitScore"`);
  }
}
