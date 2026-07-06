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

  @Column({ type: "float", nullable: true, default: null })
  coverLetterScore!: number | null;

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

  // pgvector embedding stored as text in pgvector format: [0.1,0.2,...]
  @Column({
    type: "text",
    nullable: true,
    default: null,
    name: "batch_embedding",
    select: false,
  })
  batchEmbedding!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
