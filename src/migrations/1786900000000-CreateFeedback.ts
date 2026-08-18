import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateFeedback1786900000000 implements MigrationInterface {
  name = "CreateFeedback1786900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "feedback" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "subject" varchar,
        "message" text NOT NULL,
        "isRead" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_feedback" PRIMARY KEY ("id"),
        CONSTRAINT "FK_feedback_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_feedback_user_id_createdAt" ON "feedback" ("user_id", "createdAt")`
    );
    await queryRunner.query(`CREATE INDEX "IDX_feedback_isRead" ON "feedback" ("isRead")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_feedback_isRead"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_feedback_user_id_createdAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "feedback"`);
  }
}
