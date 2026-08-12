import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMatchVerdictStatus1786700000000 implements MigrationInterface {
  name = "AddMatchVerdictStatus1786700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."applications_matchverdictstatus_enum" AS ENUM('pending', 'succeeded', 'failed')`
    );
    await queryRunner.query(
      `ALTER TABLE "applications" ADD "matchVerdictStatus" "public"."applications_matchverdictstatus_enum"`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "matchVerdictStatus"`);
    await queryRunner.query(`DROP TYPE "public"."applications_matchverdictstatus_enum"`);
  }
}
