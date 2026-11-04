import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateStaffHrAssignments1789002400000 implements MigrationInterface {
  name = "CreateStaffHrAssignments1789002400000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "staff_hr_assignments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "staff_id" uuid NOT NULL,
        "assignee_user_id" uuid NOT NULL,
        "assigned_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_hr_assignments" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_staff_hr_assignments_pair" UNIQUE ("staff_id", "assignee_user_id"),
        CONSTRAINT "FK_staff_hr_assignments_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_hr_assignments_assignee" FOREIGN KEY ("assignee_user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_hr_assignments_assigned_by" FOREIGN KEY ("assigned_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_hr_assignments_assignee" ON "staff_hr_assignments" ("assignee_user_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "staff_hr_assignments"`);
  }
}
