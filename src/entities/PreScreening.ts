import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import { GenerationStatus, PreScreeningStatus } from "../types/enums.js";
import type { User } from "./User.js";

@Entity("pre_screenings")
@Index(["userId"], { unique: true })
export class PreScreening {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne("User", { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "simple-array" })
  roles!: string[];

  @Column({ type: "jsonb", default: "[]" })
  questions!: Array<{
    questionId: string;
    question: string;
    category: string;
    options: string[];
    correctOption: number;
    intent: string;
    scoringHint?: string;
  }>;

  @Column({ type: "float", nullable: true, default: null })
  score!: number | null;

  @Column({ type: "enum", enum: PreScreeningStatus, default: PreScreeningStatus.Pending })
  status!: PreScreeningStatus;

  @Column({ default: 1 })
  attemptCount!: number;

  @Column({ default: 2 })
  maxAttempts!: number;

  @Column({ type: "timestamp" })
  generatedAt!: Date;

  @Column({ type: "enum", enum: GenerationStatus, default: GenerationStatus.Succeeded })
  generationStatus!: GenerationStatus;

  @Column({ type: "int", default: 0 })
  generationAttempts!: number;

  @Column({ type: "timestamp", nullable: true, default: null })
  generationNextRetryAt!: Date | null;

  @Column({ type: "timestamp", nullable: true, default: null })
  generationLockedAt!: Date | null;

  @Column({ type: "text", nullable: true, default: null })
  generationLastError!: string | null;

  @Column({ type: "timestamp", nullable: true, default: null })
  completedAt!: Date | null;

  // The questions for the next attempt, written ahead of time. Never loaded with the row, so
  // whole-row saves can't overwrite them; prescreening.ts reads and writes them with SQL.
  @Column({ type: "jsonb", nullable: true, default: null, select: false })
  nextQuestions!: PreScreening["questions"] | null;

  @Column({ type: "simple-array", nullable: true, default: null, select: false })
  nextRoles!: string[] | null;

  @Column({ type: "varchar", length: 16, nullable: true, default: null, select: false })
  nextGenerationStatus!: GenerationStatus | null;

  @Column({ type: "int", default: 0, select: false })
  nextGenerationAttempts!: number;

  @Column({ type: "timestamp", nullable: true, default: null, select: false })
  nextGenerationNextRetryAt!: Date | null;

  @Column({ type: "timestamp", nullable: true, default: null, select: false })
  nextGenerationLockedAt!: Date | null;

  @Column({ type: "text", nullable: true, default: null, select: false })
  nextGenerationLastError!: string | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
