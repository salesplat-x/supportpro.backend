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
import { JobStatus } from "../types/enums.js";
import type { Role } from "./Role.js";
import type { User } from "./User.js";
import type { AIConfig } from "./AIConfig.js";

@Entity("jobs")
@Index(["status", "roleId"])
export class Job {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "role_id" })
  roleId!: string;

  @ManyToOne("Role", { eager: false })
  @JoinColumn({ name: "role_id" })
  role!: Role;

  @Column({ type: "uuid", name: "posted_by_id" })
  postedById!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "posted_by_id" })
  postedBy!: User;

  @Column({ type: "uuid", nullable: true, default: null, name: "ai_config_id" })
  aiConfigId!: string | null;

  @ManyToOne("AIConfig", { nullable: true, eager: false })
  @JoinColumn({ name: "ai_config_id" })
  aiConfig!: AIConfig | null;

  @Column({ type: "text" })
  jobBrief!: string;

  @Column({ type: "enum", enum: JobStatus, default: JobStatus.Active })
  @Index()
  status!: JobStatus;

  @Column({ type: "float" })
  maxSalary!: number;

  @Column({ type: "float" })
  minSalary!: number;

  @Column({ type: "varchar" })
  experienceLevel!: string;

  @Column({ type: "varchar", nullable: true, default: null })
  locationCity!: string | null;

  @Column({ type: "varchar" })
  locationState!: string;

  @Column({ type: "varchar" })
  locationCountry!: string;

  @Column({ type: "simple-array" })
  workMode!: string[];

  @Column({ type: "varchar", nullable: true, default: null })
  currency!: string | null;

  @Column({ type: "text", nullable: true, default: null })
  requirements!: string | null;

  @Column({ type: "simple-array", nullable: true, default: null })
  skills!: string[] | null;

  @Column({ type: "simple-array", nullable: true, default: null })
  goals!: string[] | null;

  @Column({ default: 0 })
  noOfApplicants!: number;

  // pgvector embedding stored as text in pgvector format: [0.1,0.2,...]
  @Column({ type: "text", nullable: true, default: null, name: "job_embedding", select: false })
  jobEmbedding!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
