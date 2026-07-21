import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateApplicationCurrentStageDefault1784600457951 implements MigrationInterface {
  name = "UpdateApplicationCurrentStageDefault1784600457951";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ALTER COLUMN "currentStage" SET DEFAULT 'personality'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "applications" ALTER COLUMN "currentStage" SET DEFAULT 'prescreening'`
    );
  }
}
