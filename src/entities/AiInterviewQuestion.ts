import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import type { AiInterview } from "./AiInterview.js";

@Entity("ai_interview_questions")
@Unique("UQ_ai_interview_questions_position", ["interviewId", "position"])
export class AiInterviewQuestion {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "interview_id" })
  interviewId!: string;

  @ManyToOne("AiInterview", "questions", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "interview_id" })
  interview!: AiInterview;

  @Column({ type: "int" })
  position!: number;

  @Column({ type: "text" })
  question!: string;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
