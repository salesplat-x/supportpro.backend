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
import {
  ApplicationType,
  ApplicationStatus,
  ScreeningStage,
  MatchVerdict,
  MatchVerdictStatus,
  MatchRecommendation,
} from "../types/enums.js";
import type { Job } from "./Job.js";
import type { User } from "./User.js";
import type { Role } from "./Role.js";

@Entity("applications")
@Index(["talentId", "jobId"], { unique: true })
@Index(["recruiterId"])
@Index(["jobId", "status"])
export class Application {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "job_id" })
  jobId!: string;

  @ManyToOne("Job", { eager: false })
  @JoinColumn({ name: "job_id" })
  job!: Job;

  @Column({ type: "uuid", name: "talent_id" })
  talentId!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "talent_id" })
  talent!: User;

  @Column({ type: "uuid", name: "recruiter_id" })
  recruiterId!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "recruiter_id" })
  recruiter!: User;

  @Column({ type: "uuid", nullable: true, default: null, name: "role_id" })
  roleId!: string | null;

  @ManyToOne("Role", { nullable: true, eager: false })
  @JoinColumn({ name: "role_id" })
  role!: Role | null;

  @Column({ type: "enum", enum: ApplicationType })
  applicationType!: ApplicationType;

  @Column({ type: "enum", enum: ApplicationStatus, default: ApplicationStatus.Pending })
  @Index()
  status!: ApplicationStatus;

  @Column({ type: "enum", enum: ScreeningStage, default: ScreeningStage.Personality })
  currentStage!: ScreeningStage;

  @Column({ type: "jsonb", default: () => "'{}'", update: false })
  stageReachedAt!: Record<string, string>;

  @Column({ type: "simple-array", nullable: true, default: null })
  personalizedQuestions!: string[] | null;

  @Column({ type: "simple-array", nullable: true, default: null })
  personalityQuestions!: string[] | null;

  @Column({ type: "simple-array", nullable: true, default: null, update: false })
  problemSolvingQuestions!: string[] | null;

  @Column({ type: "simple-array", nullable: true, default: null, update: false })
  cultureFitQuestions!: string[] | null;

  @Column({ type: "float", nullable: true, default: null, update: false })
  problemSolvingScore!: number | null;

  @Column({ type: "float", nullable: true, default: null, update: false })
  cultureFitScore!: number | null;

  @Column({ type: "float", nullable: true, default: null })
  personalizedScore!: number | null;

  @Column({ type: "float", nullable: true, default: null })
  cvSimilarityScore!: number | null;

  @Column({ type: "int", default: 0 })
  cvSimilarityAttempts!: number;

  @Column({ type: "int", default: 0 })
  personalizedAttempts!: number;

  @Column({ type: "float", nullable: true, default: null })
  rank!: number | null;

  @Column({ type: "float", nullable: true, default: null })
  averageScore!: number | null;

  @Column({ type: "varchar", nullable: true, default: null })
  mbtiType!: string | null;

  @Column({ type: "varchar", length: 50, nullable: true, default: null })
  source!: string | null;

  /** Day 6: the AI's 0-100 judgement of how this personality fits the job. */
  @Column({ type: "float", nullable: true, default: null })
  personalityFitScore!: number | null;

  /** Day 6: the AI's one-line reason for personalityFitScore. */
  @Column({ type: "text", nullable: true, default: null })
  personalityFitReason!: string | null;

  /** Set while an AI call for the personality fit is running, so only one runs at a time. */
  @Column({ type: "timestamptz", nullable: true, default: null })
  personalityFitLockedAt!: Date | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  stages!: Record<string, string> | null;

  @Column({ type: "enum", enum: MatchVerdict, nullable: true, default: null })
  matchVerdict!: MatchVerdict | null;

  // The LLM's overall fit score (0-100) — the number the "AI Match" column and
  // ring should show. Distinct from cvSimilarityScore/averageScore, which are
  // earlier-stage pipeline scores that don't reflect the finished AI verdict.
  @Column({ type: "float", nullable: true, default: null })
  overallFitScore!: number | null;

  @Column({ type: "enum", enum: MatchVerdictStatus, nullable: true, default: null })
  matchVerdictStatus!: MatchVerdictStatus | null;

  @Column({ type: "int", default: 0 })
  matchVerdictAttempts!: number;

  @Column({ type: "timestamp", nullable: true, default: null })
  matchVerdictNextRetryAt!: Date | null;

  @Column({ type: "timestamp", nullable: true, default: null })
  matchVerdictLockedAt!: Date | null;

  @Column({ type: "text", nullable: true, default: null })
  matchVerdictLastError!: string | null;

  @Column({ type: "text", nullable: true, default: null })
  matchVerdictReasoning!: string | null;

  @Column({ type: "enum", enum: MatchRecommendation, nullable: true, default: null })
  matchRecommendation!: MatchRecommendation | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  matchStrengths!: string[] | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  matchWeaknesses!: string[] | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  matchRisks!: string[] | null;

  @Column({ type: "timestamp", nullable: true, default: null })
  assessmentRetryDate!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
