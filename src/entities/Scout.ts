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

@Entity("scouts")
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

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
