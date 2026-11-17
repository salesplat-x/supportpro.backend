import { MigrationInterface, QueryRunner } from "typeorm";

export class AddStaffSourceApplication1789005100000 implements MigrationInterface {
  name = "AddStaffSourceApplication1789005100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "staff_members" ADD "source_application_id" uuid`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_staff_members_source_application" ON "staff_members" ("source_application_id")`
    );
    await queryRunner.query(
      `ALTER TABLE "staff_members" ADD CONSTRAINT "FK_staff_members_source_application" FOREIGN KEY ("source_application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "staff_members" DROP CONSTRAINT "FK_staff_members_source_application"`
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_staff_members_source_application"`);
    await queryRunner.query(`ALTER TABLE "staff_members" DROP COLUMN "source_application_id"`);
  }
}
