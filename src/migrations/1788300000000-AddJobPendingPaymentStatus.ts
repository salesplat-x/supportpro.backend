import { MigrationInterface, QueryRunner } from "typeorm";

export class AddJobPendingPaymentStatus1788300000000 implements MigrationInterface {
  name = "AddJobPendingPaymentStatus1788300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Postgres forbids using a newly-added enum value in the same transaction
    // that added it — kept in its own migration so it commits separately
    // before OrgScopedBilling (which doesn't use it, but future migrations might).
    await queryRunner.query(
      `ALTER TYPE "public"."jobs_status_enum" ADD VALUE IF NOT EXISTS 'pending_payment'`
    );
  }

  public async down(): Promise<void> {
    // Postgres has no native DROP VALUE for enums — 'pending_payment' is left in
    // the type (harmless if unused), matching the approach in AddJobDraftStatus.
  }
}
