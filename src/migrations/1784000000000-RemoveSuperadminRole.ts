import { MigrationInterface, QueryRunner } from "typeorm";

export class RemoveSuperadminRole1784000000000 implements MigrationInterface {
  name = "RemoveSuperadminRole1784000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Production's migrations bookkeeping table has been found out of sync with
    // the actual schema. If 'superadmin' is no longer a valid users_userrole_enum
    // value, this migration's narrowing (and its idx_users_single_admin index)
    // already landed — treat a desynced re-run as a safe no-op.
    const [{ exists }] = (await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON e.enumtypid = t.oid
        WHERE t.typname = 'users_userrole_enum' AND e.enumlabel = 'superadmin'
      ) AS exists
    `)) as [{ exists: boolean }];
    if (!exists) {
      return;
    }

    // Superadmin had no registration path — collapse any existing rows into
    // 'admin' before narrowing the enum, so the type change below can't fail.
    await queryRunner.query(
      `UPDATE "users" SET "userRole" = 'admin' WHERE "userRole" = 'superadmin'`
    );

    // idx_users_talent_score is a partial index predicated on "userRole" = 'talent'
    // (added in AddVectorSupportAndIndexes) — it depends on the enum type, so it
    // must be dropped before the column's type changes and rebuilt after.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_talent_score"`);

    // Postgres has no native DROP VALUE for enums — recreate the type without it.
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "userRole" DROP DEFAULT`);
    await queryRunner.query(
      `CREATE TYPE "public"."users_userrole_enum_new" AS ENUM('admin', 'talent', 'recruiter')`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "userRole" TYPE "public"."users_userrole_enum_new" USING "userRole"::text::"public"."users_userrole_enum_new"`
    );
    await queryRunner.query(`DROP TYPE "public"."users_userrole_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."users_userrole_enum_new" RENAME TO "users_userrole_enum"`
    );
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "userRole" SET DEFAULT 'talent'`);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_talent_score
        ON users("userRole", "prescreeningScore" DESC)
        WHERE "userRole" = 'talent'
    `);

    // Enforce single-admin at the database level, independent of application logic.
    // IF NOT EXISTS as a second line of defense — this specific index is confirmed
    // to already exist in production despite this migration never being recorded
    // as applied (see 4c2f0d9's entity-side drift fix).
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_single_admin" ON "users" ("userRole") WHERE "userRole" = 'admin'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_users_single_admin"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_talent_score"`);

    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "userRole" DROP DEFAULT`);
    await queryRunner.query(
      `CREATE TYPE "public"."users_userrole_enum_old" AS ENUM('admin', 'superadmin', 'talent', 'recruiter')`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "userRole" TYPE "public"."users_userrole_enum_old" USING "userRole"::text::"public"."users_userrole_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."users_userrole_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."users_userrole_enum_old" RENAME TO "users_userrole_enum"`
    );
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "userRole" SET DEFAULT 'talent'`);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_talent_score
        ON users("userRole", "prescreeningScore" DESC)
        WHERE "userRole" = 'talent'
    `);
  }
}
