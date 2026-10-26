import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateStaffRecords1789000600000 implements MigrationInterface {
  name = "CreateStaffRecords1789000600000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "staff_members" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "user_id" uuid,
        "full_name" character varying(120) NOT NULL,
        "email" character varying(254) NOT NULL,
        "job_title" character varying(120) NOT NULL,
        "department" character varying(120),
        "manager_id" uuid,
        "start_date" date NOT NULL,
        "end_date" date,
        "status" character varying(16) NOT NULL DEFAULT 'active',
        "hired_through_auxhr" boolean NOT NULL DEFAULT false,
        "is_executive" boolean NOT NULL DEFAULT false,
        "invited_by_id" uuid,
        "invited_by_name" character varying(241),
        "invited_at" TIMESTAMP,
        "invite_token_hash" character varying(64),
        "invite_expires_at" TIMESTAMP,
        "invite_opened_at" TIMESTAMP,
        "joined_at" TIMESTAMP,
        "created_by_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_members_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_staff_members_end_date_matches_status"
          CHECK (("status" = 'ended') = ("end_date" IS NOT NULL)),
        CONSTRAINT "CHK_staff_members_ended_has_no_invite"
          CHECK ("status" <> 'ended' OR "invite_token_hash" IS NULL),
        CONSTRAINT "FK_staff_members_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_members_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_staff_members_manager" FOREIGN KEY ("manager_id")
          REFERENCES "staff_members"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_staff_members_invited_by" FOREIGN KEY ("invited_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_staff_members_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_staff_members_org_email_open"
      ON "staff_members" ("organization_id", "email") WHERE "end_date" IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_staff_members_org_user_open"
      ON "staff_members" ("organization_id", "user_id") WHERE "end_date" IS NULL
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_staff_members_invite_token_hash" ON "staff_members" ("invite_token_hash")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_members_org_status" ON "staff_members" ("organization_id", "status")`
    );

    await queryRunner.query(`
      CREATE TABLE "staff_activities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "staff_id" uuid NOT NULL,
        "actor_id" uuid,
        "actor_name" character varying(241) NOT NULL,
        "type" character varying(32) NOT NULL,
        "meta" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_activities_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_staff_activities_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_activities_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_activities_actor" FOREIGN KEY ("actor_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_activities_staff_created" ON "staff_activities" ("staff_id", "created_at")`
    );

    await queryRunner.query(`
      CREATE TABLE "staff_access_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "actor_id" uuid,
        "actor_name" character varying(241) NOT NULL,
        "staff_id" uuid,
        "staff_name" character varying(241) NOT NULL,
        "resource" character varying(32) NOT NULL,
        "ip" character varying(64),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_access_logs_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_staff_access_logs_org" FOREIGN KEY ("organization_id")
          REFERENCES "organizations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_staff_access_logs_actor" FOREIGN KEY ("actor_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_staff_access_logs_staff" FOREIGN KEY ("staff_id")
          REFERENCES "staff_members"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_staff_access_logs_org_created" ON "staff_access_logs" ("organization_id", "created_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_staff_access_logs_org_created"`);
    await queryRunner.query(`DROP TABLE "staff_access_logs"`);
    await queryRunner.query(`DROP INDEX "IDX_staff_activities_staff_created"`);
    await queryRunner.query(`DROP TABLE "staff_activities"`);
    await queryRunner.query(`DROP INDEX "IDX_staff_members_org_status"`);
    await queryRunner.query(`DROP INDEX "UQ_staff_members_invite_token_hash"`);
    await queryRunner.query(`DROP INDEX "UQ_staff_members_org_user_open"`);
    await queryRunner.query(`DROP INDEX "UQ_staff_members_org_email_open"`);
    await queryRunner.query(`DROP TABLE "staff_members"`);
  }
}
