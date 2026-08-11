import { MigrationInterface, QueryRunner } from "typeorm";

export class OrganizationOwnershipAndVerification1786421218993 implements MigrationInterface {
  name = "OrganizationOwnershipAndVerification1786421218993";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "FK_21a659804ed7bf61eb91688dea7"`);
    await queryRunner.query(
      `ALTER TABLE "users" RENAME COLUMN "organization_id" TO "active_organization_id"`
    );
    await queryRunner.query(`ALTER TABLE "organizations" ADD "owner_id" uuid`);
    // Backfill: whichever recruiter was linked to an org today (now
    // users.active_organization_id, renamed above) becomes its owner.
    // Orgs with no linked user are left with owner_id NULL — there's no
    // correct value to infer, and the column stays nullable at the DB
    // level for exactly this reason.
    await queryRunner.query(
      `UPDATE "organizations" o SET "owner_id" = u.id FROM "users" u WHERE u."active_organization_id" = o.id`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."organizations_status_enum" AS ENUM('pending', 'verified', 'rejected')`
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "status" "public"."organizations_status_enum" NOT NULL DEFAULT 'pending'`
    );
    await queryRunner.query(`ALTER TABLE "organizations" ADD "verified_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "organizations" ADD "verified_by_id" uuid`);
    await queryRunner.query(`ALTER TABLE "jobs" ADD "organization_id" uuid`);
    // Backfill: jobs didn't carry an organization before this migration,
    // so attribute each existing job to whatever company its poster was
    // on at migration time. Jobs whose poster had no active company are
    // left NULL (same rationale as owner_id above).
    await queryRunner.query(
      `UPDATE "jobs" j SET "organization_id" = u."active_organization_id" FROM "users" u WHERE u.id = j."posted_by_id" AND u."active_organization_id" IS NOT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "FK_b6efb6c252106821c8bd822af86" FOREIGN KEY ("active_organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD CONSTRAINT "FK_e08c0b40ce104f44edf060126fe" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD CONSTRAINT "FK_59d92dd6a87ea2093d2a796e850" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD CONSTRAINT "FK_3d9a2080fffe3e2c3b72fd56df2" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT "FK_3d9a2080fffe3e2c3b72fd56df2"`);
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT "FK_59d92dd6a87ea2093d2a796e850"`
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP CONSTRAINT "FK_e08c0b40ce104f44edf060126fe"`
    );
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "FK_b6efb6c252106821c8bd822af86"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "organization_id"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "verified_by_id"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "verified_at"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "status"`);
    await queryRunner.query(`DROP TYPE "public"."organizations_status_enum"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "owner_id"`);
    await queryRunner.query(
      `ALTER TABLE "users" RENAME COLUMN "active_organization_id" TO "organization_id"`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "FK_21a659804ed7bf61eb91688dea7" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
