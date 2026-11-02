import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProblemSolvingCultureFitQuestionTypes1789000700000 implements MigrationInterface {
  name = "AddProblemSolvingCultureFitQuestionTypes1789000700000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const enumType of ["questions_type_enum", "answers_questiontype_enum"]) {
      for (const value of ["problem_solving", "culture_fit"]) {
        await queryRunner.query(
          `ALTER TYPE "public"."${enumType}" ADD VALUE IF NOT EXISTS '${value}'`
        );
      }
    }
  }

  public async down(): Promise<void> {}
}
