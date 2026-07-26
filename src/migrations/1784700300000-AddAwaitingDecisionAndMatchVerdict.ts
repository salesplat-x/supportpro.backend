import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAwaitingDecisionAndMatchVerdict1784700300000 implements MigrationInterface {
  name = "AddAwaitingDecisionAndMatchVerdict1784700300000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Postgres forbids using a newly-added enum value in the same transaction that
    // added it — but nothing in this migration writes 'awaiting_decision' rows, so
    // it's safe to add here (see AddJobDraftStatus for the transaction-boundary case).
    await queryRunner.query(
      `ALTER TYPE "public"."applications_status_enum" ADD VALUE IF NOT EXISTS 'awaiting_decision'`
    );

    await queryRunner.query(
      `CREATE TYPE "public"."applications_matchverdict_enum" AS ENUM('high', 'medium', 'low')`
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "matchVerdict" "public"."applications_matchverdict_enum"`
    );
    await queryRunner.query(`ALTER TABLE "applications" ADD "matchVerdictReasoning" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "matchVerdictReasoning"`);
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "matchVerdict"`);
    await queryRunner.query(`DROP TYPE "public"."applications_matchverdict_enum"`);
    // Postgres has no native DROP VALUE for enums — 'awaiting_decision' is left in
    // applications_status_enum (harmless if unused), matching AddJobDraftStatus.
  }
}
