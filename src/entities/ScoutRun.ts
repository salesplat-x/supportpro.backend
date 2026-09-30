import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from "typeorm";
import type { User } from "./User.js";
import type { ScoutJob } from "./ScoutJob.js";
import type { Organization } from "./Organization.js";
import { ScoutRunStatus } from "../types/enums.js";

/**
 * One upload of CVs against a campaign. Scoring happens in the background, so
 * this row is the durable record of the run: it is created before any LLM work
 * starts and is what the UI polls.
 */
@Entity("scout_runs")
@Unique("UQ_scout_runs_job_idempotency", ["scoutJobId", "idempotencyKey"])
@Index("IDX_scout_runs_job_created", ["scoutJobId", "createdAt"])
export class ScoutRun {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "scout_job_id" })
  scoutJobId!: string;

  @ManyToOne("ScoutJob", {
    eager: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "scout_job_id", foreignKeyConstraintName: "FK_scout_runs_scout_job" })
  scoutJob!: ScoutJob;

  @Column({ type: "uuid", name: "recruiter_id" })
  recruiterId!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "recruiter_id", foreignKeyConstraintName: "FK_scout_runs_recruiter" })
  recruiter!: User;

  @Column({ type: "uuid", nullable: true, default: null, name: "organization_id" })
  organizationId!: string | null;

  @ManyToOne("Organization", { nullable: true, eager: false })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_scout_runs_organization" })
  organization!: Organization | null;

  /**
   * Client-generated per-upload key. Combined with scoutJobId it is unique, so a
   * double-submit collides instead of starting a second run and spending again.
   */
  @Column({ type: "varchar", name: "idempotency_key" })
  idempotencyKey!: string;

  @Column({
    type: "enum",
    enum: ScoutRunStatus,
    default: ScoutRunStatus.Processing,
  })
  status!: ScoutRunStatus;

  @Column({ type: "int", name: "total_cvs" })
  totalCvs!: number;

  /**
   * Snapshot of the campaign's shortlistSize when the run started, so editing the
   * campaign later cannot retroactively change how many candidates a finished run
   * shortlisted.
   */
  @Column({ type: "int", name: "shortlist_size" })
  shortlistSize!: number;

  @Column({ type: "text", nullable: true, default: null, name: "shortlist_summary" })
  shortlistSummary!: string | null;

  @Column({ type: "timestamp with time zone", nullable: true, default: null, name: "completed_at" })
  completedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
