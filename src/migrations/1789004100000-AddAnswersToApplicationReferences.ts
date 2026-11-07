import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAnswersToApplicationReferences1789004100000 implements MigrationInterface {
  name = "AddAnswersToApplicationReferences1789004100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "application_references" ADD "answers" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "application_references" DROP COLUMN "answers"`);
  }
}
