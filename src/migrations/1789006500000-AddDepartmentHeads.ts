import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDepartmentHeads1789006500000 implements MigrationInterface {
  name = "AddDepartmentHeads1789006500000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "departments" ADD "head_staff_id" uuid`);
    await queryRunner.query(
      `CREATE INDEX "IDX_departments_head" ON "departments" ("head_staff_id")`
    );
    await queryRunner.query(`
      ALTER TABLE "departments" ADD CONSTRAINT "FK_departments_head"
        FOREIGN KEY ("head_staff_id") REFERENCES "staff_members"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "departments" DROP CONSTRAINT "FK_departments_head"`);
    await queryRunner.query(`DROP INDEX "IDX_departments_head"`);
    await queryRunner.query(`ALTER TABLE "departments" DROP COLUMN "head_staff_id"`);
  }
}
