import { MigrationInterface, QueryRunner } from "typeorm";

export class SetJobDefaultStatusDraft1783837810000 implements MigrationInterface {
  name = "SetJobDefaultStatusDraft1783837810000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Split from AddJobDraftStatus1783837800000 — this must run in its own
    // committed transaction so the 'draft' enum value added there is usable here.
    await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'draft'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'active'`);
  }
}
