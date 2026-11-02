import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPersonalityFitLockToApplications1789001250000 implements MigrationInterface {
  name = "AddPersonalityFitLockToApplications1789001250000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "personalityFitLockedAt" TIMESTAMP WITH TIME ZONE`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "personalityFitLockedAt"`);
  }
}
