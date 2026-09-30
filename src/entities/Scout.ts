import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import type { User } from "./User.js";
import type { ScoutJob } from "./ScoutJob.js";
import type { ScoutRun } from "./ScoutRun.js";
import type { ScoutCandidate } from "./ScoutCandidate.js";
import { ScoutCvStatus } from "../types/enums.js";

@Entity("scouts")
@Index("IDX_scouts_due", ["status", "nextRetryAt"])
export class Scout {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", nullable: true, default: null })
  @Index()
  batchId!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  cvName!: string | null;

  @Column({ type: "text", nullable: true, default: null })
  cvText!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  coverLetterName!: string | null;

  @Column({ type: "text", nullable: true, default: null })
  coverLetterText!: string | null;

  @Column({ type: "float", nullable: true, default: null })
  cvScore!: number | null;

  @Column({ type: "text", nullable: true, default: null })
  insights!: string | null;

  @Column({ type: "float", nullable: true, default: null })
  coverLetterScore!: number | null;

  @Column({ type: "text", nullable: true, default: null })
  coverLetterInsights!: string | null;

  @Column({ type: "float", nullable: true, default: null })
  evaluationScore!: number | null;

  @Column({ type: "varchar", nullable: true, default: null })
  candidateName!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  candidateEmail!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  candidatePhone!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  candidateAddress!: string | null;

  @Column({ type: "uuid", nullable: true, default: null, name: "recruiter_id" })
  recruiterId!: string | null;

  @ManyToOne("User", { nullable: true, eager: false })
  @JoinColumn({ name: "recruiter_id" })
  recruiter!: User | null;

  @Column({ type: "uuid", nullable: true, default: null, name: "scout_job_id" })
  scoutJobId!: string | null;

  @ManyToOne("ScoutJob", { nullable: true, eager: false })
  @JoinColumn({ name: "scout_job_id" })
  scoutJob!: ScoutJob | null;

  // SHA-256 hash of cvText — lets a repeat upload of the same CV skip re-scoring.
  @Column({ type: "varchar", nullable: true, default: null, name: "cv_text_hash" })
  @Index()
  cvTextHash!: string | null;

  @Column({ type: "uuid", nullable: true, default: null, name: "scout_run_id" })
  @Index("IDX_scouts_scout_run_id")
  scoutRunId!: string | null;

  @ManyToOne("ScoutRun", { nullable: true, eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "scout_run_id", foreignKeyConstraintName: "FK_scouts_scout_run" })
  scoutRun!: ScoutRun | null;

  @Column({ type: "enum", enum: ScoutCvStatus, default: ScoutCvStatus.Queued })
  status!: ScoutCvStatus;

  /**
   * Zero-based index of this CV within its upload. Every row in a batch is inserted
   * in one statement and so shares a `createdAt` to the microsecond — this is what
   * makes "equal scores break by upload order" actually hold.
   */
  @Column({ type: "int", nullable: true, default: null })
  position!: number | null;

  @Column({ type: "int", default: 0 })
  attempts!: number;

  @Column({
    type: "timestamp with time zone",
    nullable: true,
    default: null,
    name: "next_retry_at",
  })
  nextRetryAt!: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true, default: null, name: "locked_at" })
  lockedAt!: Date | null;

  @Column({ type: "text", nullable: true, default: null, name: "last_error" })
  lastError!: string | null;

  /**
   * Rank within the run, assigned once at finalization from a fully deterministic
   * ordering. Persisted rather than derived so re-sorting the table can never
   * change what rank a candidate was given.
   */
  @Column({ type: "int", nullable: true, default: null })
  rank!: number | null;

  @Column({ type: "boolean", default: false })
  shortlisted!: boolean;

  /** Plain-English reason the AI gave for its view of this candidate. */
  @Column({ type: "text", nullable: true, default: null })
  recommendation!: string | null;

  @Column({ type: "varchar", nullable: true, default: null, name: "cv_file_url" })
  cvFileUrl!: string | null;

  /** Spaces object key — the worker reads the file back from here, so a run resumes after a restart. */
  @Column({ type: "varchar", nullable: true, default: null, name: "cv_file_key" })
  cvFileKey!: string | null;

  @Column({ type: "varchar", nullable: true, default: null, name: "cv_mime_type" })
  cvMimeType!: string | null;

  @Column({ type: "int", nullable: true, default: null, name: "cv_file_size" })
  cvFileSize!: number | null;

  @Column({ type: "uuid", nullable: true, default: null, name: "candidate_id" })
  @Index("IDX_scouts_candidate_id")
  candidateId!: string | null;

  @ManyToOne("ScoutCandidate", { nullable: true, eager: false, onDelete: "SET NULL" })
  @JoinColumn({ name: "candidate_id", foreignKeyConstraintName: "FK_scouts_candidate" })
  candidate!: ScoutCandidate | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
