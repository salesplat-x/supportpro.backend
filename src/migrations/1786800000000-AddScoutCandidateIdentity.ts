import { MigrationInterface, QueryRunner } from "typeorm";

export class AddScoutCandidateIdentity1786800000000 implements MigrationInterface {
  name = "AddScoutCandidateIdentity1786800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "candidateName" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "candidateEmail" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "candidatePhone" varchar`
    );
    await queryRunner.query(
      `ALTER TABLE "scouts" ADD COLUMN IF NOT EXISTS "candidateAddress" varchar`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "scouts" DROP COLUMN "candidateAddress"`);
    await queryRunner.query(`ALTER TABLE "scouts" DROP COLUMN "candidatePhone"`);
    await queryRunner.query(`ALTER TABLE "scouts" DROP COLUMN "candidateEmail"`);
    await queryRunner.query(`ALTER TABLE "scouts" DROP COLUMN "candidateName"`);
  }
}
