import { MigrationInterface, QueryRunner } from "typeorm";

export class AddChecklistTaskOwnerAndDescription1789006100000 implements MigrationInterface {
  name = "AddChecklistTaskOwnerAndDescription1789006100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "staff_checklist_tasks"
        ADD COLUMN "description" character varying(200),
        ADD COLUMN "owner" character varying(16)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "staff_checklist_tasks"
        DROP COLUMN "owner",
        DROP COLUMN "description"
    `);
  }
}
