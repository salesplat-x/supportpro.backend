import { MigrationInterface, QueryRunner } from "typeorm";

export class AddApplicantNoteToApplications1789004600000 implements MigrationInterface {
  name = "AddApplicantNoteToApplications1789004600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" ADD "applicantNote" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "applications" DROP COLUMN "applicantNote"`);
  }
}
