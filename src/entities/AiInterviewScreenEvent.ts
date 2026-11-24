import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
  Check,
} from "typeorm";
import type { AiInterview } from "./AiInterview.js";
import type { AiInterviewQuestion } from "./AiInterviewQuestion.js";

export const SCREEN_EVENT_KINDS = ["tab_hidden", "window_blur", "fullscreen_exit"] as const;
export type ScreenEventKind = (typeof SCREEN_EVENT_KINDS)[number];

/** One time a candidate left the interview screen while answering. Shown to the hiring team. */
@Entity("ai_interview_screen_events")
@Check(
  "CHK_ai_interview_screen_events_kind",
  `"kind" IN ('tab_hidden', 'window_blur', 'fullscreen_exit')`
)
@Index("IDX_ai_interview_screen_events_interview", ["interviewId", "occurredAt"])
export class AiInterviewScreenEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "interview_id" })
  interviewId!: string;

  @ManyToOne("AiInterview", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({
    name: "interview_id",
    foreignKeyConstraintName: "FK_ai_interview_screen_events_interview",
  })
  interview!: AiInterview;

  @Column({ type: "uuid", name: "question_id", nullable: true })
  questionId!: string | null;

  @ManyToOne("AiInterviewQuestion", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({
    name: "question_id",
    foreignKeyConstraintName: "FK_ai_interview_screen_events_question",
  })
  question!: AiInterviewQuestion | null;

  @Column({ type: "varchar", length: 24 })
  kind!: ScreenEventKind;

  @CreateDateColumn({ type: "timestamptz", name: "occurred_at" })
  occurredAt!: Date;
}
