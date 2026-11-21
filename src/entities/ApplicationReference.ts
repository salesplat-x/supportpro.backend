import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { Application } from "./Application.js";
import type { Job } from "./Job.js";
import type { ReferenceQuestion } from "../types/referenceQuestion.js";
import type { User } from "./User.js";

@Entity("application_references")
@Index("UQ_application_references_email", ["applicationId", "email"], { unique: true })
@Index("UQ_application_references_token", ["tokenHash"], { unique: true })
export class ApplicationReference {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "application_id" })
  applicationId!: string;

  @ManyToOne("Application", { onDelete: "CASCADE", eager: false })
  @JoinColumn({
    name: "application_id",
    foreignKeyConstraintName: "FK_application_references_application",
  })
  application!: Application;

  @Column({ type: "uuid", name: "job_id" })
  jobId!: string;

  @ManyToOne("Job", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "job_id", foreignKeyConstraintName: "FK_application_references_job" })
  job!: Job;

  @Column({ type: "uuid", name: "talent_id" })
  talentId!: string;

  @ManyToOne("User", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "talent_id", foreignKeyConstraintName: "FK_application_references_talent" })
  talent!: User;

  @Column({ type: "varchar", length: 120 })
  name!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 120 })
  relationship!: string;

  @Column({ type: "varchar", length: 64, name: "token_hash" })
  tokenHash!: string;

  @Column({ type: "timestamptz", name: "token_expires_at" })
  tokenExpiresAt!: Date;

  @Column({ type: "timestamptz", name: "sent_at", nullable: true, default: null })
  sentAt!: Date | null;

  @Column({ type: "timestamptz", name: "answered_at", nullable: true, default: null })
  answeredAt!: Date | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  questions!: ReferenceQuestion[] | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  answers!: Record<string, string> | null;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt!: Date;
}
