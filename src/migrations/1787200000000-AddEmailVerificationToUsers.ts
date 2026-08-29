import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmailVerificationToUsers1787200000000 implements MigrationInterface {
  name = "AddEmailVerificationToUsers1787200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP DEFAULT NULL`
    );
    await queryRunner.query(
      `UPDATE "users" SET "emailVerifiedAt" = now() WHERE "emailVerified" = true`
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "emailVerified"`);
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerificationTokenHash" character varying DEFAULT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerificationTokenExpiresAt" TIMESTAMP DEFAULT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "welcomeEmailSentAt" TIMESTAMP DEFAULT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerified" boolean DEFAULT true`
    );
    await queryRunner.query(
      `UPDATE "users" SET "emailVerified" = ("emailVerifiedAt" IS NOT NULL)`
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "emailVerifiedAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "emailVerificationTokenHash"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "emailVerificationTokenExpiresAt"`
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "welcomeEmailSentAt"`);
  }
}
