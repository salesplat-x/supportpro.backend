import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import { QuestionType } from "../types/enums.js";
import type { Role } from "./Role.js";
import type { Job } from "./Job.js";
import type { User } from "./User.js";

@Entity("answers")
export class Answer {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", nullable: true, default: null, name: "role_id" })
  roleId!: string | null;

  @ManyToOne("Role", { nullable: true, eager: false })
  @JoinColumn({ name: "role_id" })
  role!: Role | null;

  @Column({ type: "uuid", nullable: true, default: null, name: "job_id" })
  jobId!: string | null;

  @ManyToOne("Job", { nullable: true, eager: false })
  @JoinColumn({ name: "job_id" })
  job!: Job | null;

  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "enum", enum: QuestionType })
  questionType!: QuestionType;

  @Column({ type: "jsonb", default: "[]" })
  responses!: Array<{
    questionId: string;
    answer: string;
    selectedOption?: number;
    score?: number;
    feedback?: string;
    dichotomyPreference?: string;
  }>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
