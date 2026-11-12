import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { Application } from "./Application.js";
import type { Job } from "./Job.js";
import type { User } from "./User.js";
import type { AiInterviewQuestion } from "./AiInterviewQuestion.js";
import type { AiInterviewMode } from "../types/enums.js";

export type AiInterviewStatus = "pending" | "ready" | "invited" | "failed";

export type AiInterviewScoringStatus = "pending" | "completed" | "failed";

export interface AiInterviewScore {
  score: number;
  reason: string;
}

export interface AiInterviewScores {
  clearSpeaking: AiInterviewScore;
  fitForRole: AiInterviewScore;
  confidence: AiInterviewScore;
}

@Entity("ai_interviews")
@Index("UQ_ai_interviews_application", ["applicationId"], { unique: true })
export class AiInterview {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "application_id" })
  applicationId!: string;

  @ManyToOne("Application", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "application_id", foreignKeyConstraintName: "FK_ai_interviews_application" })
  application!: Application;

  @Column({ type: "uuid", name: "job_id" })
  jobId!: string;

  @ManyToOne("Job", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "job_id", foreignKeyConstraintName: "FK_ai_interviews_job" })
  job!: Job;

  @Column({ type: "uuid", name: "talent_id" })
  talentId!: string;

  @ManyToOne("User", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "talent_id", foreignKeyConstraintName: "FK_ai_interviews_talent" })
  talent!: User;

  @Column({ type: "varchar", length: 20 })
  mode!: AiInterviewMode;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status!: AiInterviewStatus;

  @Column({ type: "timestamptz", name: "invited_at", nullable: true, default: null })
  invitedAt!: Date | null;

  @OneToMany("AiInterviewQuestion", "interview")
  questions!: AiInterviewQuestion[];

  @Column({ type: "varchar", length: 20, name: "scoring_status", nullable: true, default: null })
  scoringStatus!: AiInterviewScoringStatus | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  scores!: AiInterviewScores | null;

  @Column({ type: "text", nullable: true, default: null })
  summary!: string | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  flags!: string[] | null;

  @Column({ type: "timestamptz", name: "scored_at", nullable: true, default: null })
  scoredAt!: Date | null;

  @Column({ type: "int", name: "scoring_attempts", default: 0 })
  scoringAttempts!: number;

  @Column({ type: "timestamptz", name: "scoring_next_retry_at", nullable: true, default: null })
  scoringNextRetryAt!: Date | null;

  @Column({ type: "timestamptz", name: "scoring_locked_at", nullable: true, default: null })
  scoringLockedAt!: Date | null;

  @Column({ type: "text", name: "scoring_last_error", nullable: true, default: null })
  scoringLastError!: string | null;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt!: Date;
}
