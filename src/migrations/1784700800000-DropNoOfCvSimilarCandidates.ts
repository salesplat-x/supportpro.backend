import { MigrationInterface, QueryRunner } from "typeorm";

export class DropNoOfCvSimilarCandidates1784700800000 implements MigrationInterface {
  name = "DropNoOfCvSimilarCandidates1784700800000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_configs" DROP COLUMN "noOfCvSimilarCandidates"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_configs" ADD "noOfCvSimilarCandidates" integer`);
  }
}
