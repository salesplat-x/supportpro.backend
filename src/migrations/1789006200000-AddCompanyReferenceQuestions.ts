import { MigrationInterface, QueryRunner } from "typeorm";

const ORIGINAL_QUESTIONS = [
  { key: "worked_together", question: "How did you work together?", type: "text", required: true },
  { key: "strengths", question: "What are their strengths?", type: "text", required: true },
  { key: "improve", question: "What could they improve?", type: "text", required: true },
  { key: "reliability", question: "How reliable are they?", type: "text", required: true },
  { key: "hire_again", question: "Would you hire them again?", type: "yesno", required: true },
  {
    key: "anything_else",
    question: "Anything else you want us to know?",
    type: "text",
    required: false,
  },
];

export class AddCompanyReferenceQuestions1789006200000 implements MigrationInterface {
  name = "AddCompanyReferenceQuestions1789006200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organizations" ADD "reference_questions" jsonb`);
    await queryRunner.query(`ALTER TABLE "application_references" ADD "questions" jsonb`);
    await queryRunner.query(
      `UPDATE "application_references" SET "questions" = $1::jsonb
       WHERE "sent_at" IS NOT NULL OR "answered_at" IS NOT NULL`,
      [JSON.stringify(ORIGINAL_QUESTIONS)]
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "application_references" DROP COLUMN "questions"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "reference_questions"`);
  }
}
