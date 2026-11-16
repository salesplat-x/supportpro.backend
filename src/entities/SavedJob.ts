import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import type { Job } from "./Job.js";
import type { User } from "./User.js";

@Entity("saved_jobs")
@Index("UQ_saved_jobs_user_job", ["userId", "jobId"], { unique: true })
export class SavedJob {
  @PrimaryGeneratedColumn("uuid", { primaryKeyConstraintName: "PK_saved_jobs_id" })
  id!: string;

  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne("User", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "user_id", foreignKeyConstraintName: "FK_saved_jobs_user" })
  user!: User;

  @Column({ type: "uuid", name: "job_id" })
  jobId!: string;

  @ManyToOne("Job", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "job_id", foreignKeyConstraintName: "FK_saved_jobs_job" })
  job!: Job;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
