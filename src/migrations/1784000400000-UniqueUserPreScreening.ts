import { MigrationInterface, QueryRunner } from "typeorm";

export class UniqueUserPreScreening1784000400000 implements MigrationInterface {
  name = "UniqueUserPreScreening1784000400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A client polling GET /prescreening/ twice before the first fire-and-forget
    // generation commits can trigger generation a second time, and with no
    // uniqueness guarantee that creates a second pre_screenings row for the same
    // user. Repoint any user whose active_prescreening_id points at a row we're
    // about to remove, to the row we're keeping, before removing duplicates.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id, user_id,
               ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY "createdAt" DESC) AS rn
        FROM "pre_screenings"
      )
      UPDATE "users" u
      SET "active_prescreening_id" = keep.id
      FROM ranked keep, ranked dupe
      WHERE keep.rn = 1
        AND dupe.rn > 1
        AND dupe.user_id = keep.user_id
        AND u."active_prescreening_id" = dupe.id
    `);

    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY "createdAt" DESC) AS rn
        FROM "pre_screenings"
      )
      DELETE FROM "pre_screenings" p
      USING ranked
      WHERE p.id = ranked.id AND ranked.rn > 1
    `);

    await queryRunner.query(`DROP INDEX "public"."IDX_b0cd8d1ec347dcff1d6609a0db"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_b0cd8d1ec347dcff1d6609a0db" ON "pre_screenings" ("user_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_b0cd8d1ec347dcff1d6609a0db"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_b0cd8d1ec347dcff1d6609a0db" ON "pre_screenings" ("user_id")`
    );
  }
}
