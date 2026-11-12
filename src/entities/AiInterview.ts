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

@Entity("ai_interviews")
@Index("UQ_ai_interviews_application", ["applicationId"], { unique: true })
export class AiInterview {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "application_id" })
  applicationId!: string;

  @ManyToOne("Application", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "application_id" })
  application!: Application;

  @Column({ type: "uuid", name: "job_id" })
  jobId!: string;

  @ManyToOne("Job", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "job_id" })
  job!: Job;

  @Column({ type: "uuid", name: "talent_id" })
  talentId!: string;

  @ManyToOne("User", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "talent_id" })
  talent!: User;

  @Column({ type: "varchar", length: 20 })
  mode!: AiInterviewMode;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status!: AiInterviewStatus;

  @Column({ type: "timestamptz", name: "invited_at", nullable: true, default: null })
  invitedAt!: Date | null;

  @OneToMany("AiInterviewQuestion", "interview")
  questions!: AiInterviewQuestion[];

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt!: Date;
}
