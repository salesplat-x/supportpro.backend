import { MigrationInterface, QueryRunner } from "typeorm";
import logger from "../utils/logger.js";

const BATCH = 10;

// Older rows stored only the public URL; the object key is its path.
const KEY = `COALESCE("cvKey", regexp_replace("cvUrl", '^https?://[^/]+/', ''))`;

// Talent CVs used to be uploaded public-read. This closes the existing files and drops their
// public links, so a CV is only reachable through the signed-in CV download route.
export class MakeTalentCvsPrivate1789007300000 implements MigrationInterface {
  name = "MakeTalentCvsPrivate1789007300000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ cvKey: string }> = await queryRunner.query(
      `SELECT ${KEY} AS "cvKey" FROM "users" WHERE "cvUrl" IS NOT NULL`
    );
    if (rows.length === 0) return;

    // Loaded only when there are CVs, so the drift check can run this without app config.
    const { isSpacesConfigured, makeSpacesObjectPrivate } =
      await import("../utils/integrations/spaces.js");
    if (isSpacesConfigured()) {
      let failed = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const results = await Promise.allSettled(
          rows.slice(i, i + BATCH).map((row) => makeSpacesObjectPrivate(row.cvKey))
        );
        failed += results.filter((result) => result.status === "rejected").length;
      }
      if (failed > 0) {
        logger.error(`Could not make ${failed} of ${rows.length} talent CVs private`);
      }
    }

    await queryRunner.query(
      `UPDATE "users" SET "cvKey" = ${KEY}, "cvUrl" = NULL WHERE "cvUrl" IS NOT NULL`
    );
  }

  public async down(): Promise<void> {}
}
