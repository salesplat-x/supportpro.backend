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

@Entity("questions")
export class Question {
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

  @Column({ type: "enum", enum: QuestionType })
  type!: QuestionType;

  @Column({ type: "text" })
  question!: string;

  @Column({ type: "varchar", nullable: true, default: null })
  criteria!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  category!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
