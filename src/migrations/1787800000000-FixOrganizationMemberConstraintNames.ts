import { MigrationInterface, QueryRunner } from "typeorm";

export class FixOrganizationMemberConstraintNames1787800000000 implements MigrationInterface {
  name = "FixOrganizationMemberConstraintNames1787800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organization_members" DROP CONSTRAINT "FK_org_members_user"`
    );
    await queryRunner.query(
      `ALTER TABLE "organization_members" DROP CONSTRAINT "FK_org_members_org"`
    );
    await queryRunner.query(
      `ALTER TABLE "organization_join_requests" DROP CONSTRAINT "FK_org_join_requests_user"`
    );
    await queryRunner.query(
      `ALTER TABLE "organization_join_requests" DROP CONSTRAINT "FK_org_join_requests_org"`
    );

    await queryRunner.query(
      `ALTER TABLE "organization_members" ALTER COLUMN "verified_at" SET DEFAULT now()`
    );

    await queryRunner.query(
      `ALTER TABLE "organization_members" ADD CONSTRAINT "FK_89bde91f78d36ca41e9515d91c6" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "organization_members" ADD CONSTRAINT "FK_7062a4fbd9bab22ffd918e5d3d9" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "organization_join_requests" ADD CONSTRAINT "FK_86b44339c6a54e58d4639ddc4ac" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "organization_join_requests" ADD CONSTRAINT "FK_94ad243453073e7489da74f0b51" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organization_join_requests" DROP CONSTRAINT "FK_94ad243453073e7489da74f0b51"`
    );
    await queryRunner.query(
      `ALTER TABLE "organization_join_requests" DROP CONSTRAINT "FK_86b44339c6a54e58d4639ddc4ac"`
    );
    await queryRunner.query(
      `ALTER TABLE "organization_members" DROP CONSTRAINT "FK_7062a4fbd9bab22ffd918e5d3d9"`
    );
    await queryRunner.query(
      `ALTER TABLE "organization_members" DROP CONSTRAINT "FK_89bde91f78d36ca41e9515d91c6"`
    );

    await queryRunner.query(
      `ALTER TABLE "organization_members" ALTER COLUMN "verified_at" SET DEFAULT CURRENT_TIMESTAMP`
    );

    await queryRunner.query(
      `ALTER TABLE "organization_join_requests" ADD CONSTRAINT "FK_org_join_requests_org" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "organization_join_requests" ADD CONSTRAINT "FK_org_join_requests_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "organization_members" ADD CONSTRAINT "FK_org_members_org" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "organization_members" ADD CONSTRAINT "FK_org_members_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE`
    );
  }
}
