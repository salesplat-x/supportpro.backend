import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPerformanceFoundations1789001700000 implements MigrationInterface {
  name = "AddPerformanceFoundations1789001700000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "people_ai_claims" (
        "key" character varying(120) NOT NULL,
        "token" uuid NOT NULL,
        "claimed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_people_ai_claims_key" PRIMARY KEY ("key")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_members_manager" ON "staff_members" ("manager_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_staff_members_manager"`);
    await queryRunner.query(`DROP TABLE "people_ai_claims"`);
  }
}
