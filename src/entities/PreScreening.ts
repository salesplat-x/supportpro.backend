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
import { PreScreeningStatus } from "../types/enums.js";
import type { User } from "./User.js";

@Entity("pre_screenings")
@Index(["userId"])
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

  @Column({ type: "timestamp", nullable: true, default: null })
  completedAt!: Date | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
