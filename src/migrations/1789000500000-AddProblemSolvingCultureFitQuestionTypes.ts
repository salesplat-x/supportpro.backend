import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProblemSolvingCultureFitQuestionTypes1789000500000 implements MigrationInterface {
  name = "AddProblemSolvingCultureFitQuestionTypes1789000500000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Postgres forbids using a newly-added enum value in the same transaction
    // that added it — kept in its own migration (nothing here uses the values)
    // so they commit before any later migration might.
    for (const enumType of ["questions_type_enum", "answers_questiontype_enum"]) {
      for (const value of ["problem_solving", "culture_fit"]) {
        await queryRunner.query(
          `ALTER TYPE "public"."${enumType}" ADD VALUE IF NOT EXISTS '${value}'`
        );
      }
    }
  }

  public async down(): Promise<void> {
    // Postgres has no native DROP VALUE for enums — the values are left in the
    // types (harmless if unused), matching AddJobPendingPaymentStatus.
  }
}
