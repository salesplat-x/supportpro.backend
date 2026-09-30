import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `feature_usage_counters.organization_id` has always been a plain uuid column —
 * the entity declares the relation but the FK was never created, so a deleted
 * organization left its usage rows behind. Orphans are cleared first so the
 * constraint can be added on existing databases.
 */
export class AddFeatureUsageCounterOrganizationFk1789000200000 implements MigrationInterface {
  name = "AddFeatureUsageCounterOrganizationFk1789000200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "feature_usage_counters"
       WHERE "organization_id" NOT IN (SELECT "id" FROM "organizations")
    `);
    await queryRunner.query(`
      ALTER TABLE "feature_usage_counters"
        ADD CONSTRAINT "FK_feature_usage_counters_organization"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
        ON DELETE NO ACTION ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "feature_usage_counters" DROP CONSTRAINT IF EXISTS "FK_feature_usage_counters_organization"`
    );
  }
}
