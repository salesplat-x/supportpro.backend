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

export type AiInterviewTranscriptStatus = "pending" | "completed" | "failed";

@Entity("ai_interview_questions")
@Unique("UQ_ai_interview_questions_position_follow_up", ["interviewId", "position", "isFollowUp"])
export class AiInterviewQuestion {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "interview_id" })
  interviewId!: string;

  @ManyToOne("AiInterview", "questions", { onDelete: "CASCADE", eager: false })
  @JoinColumn({
    name: "interview_id",
    foreignKeyConstraintName: "FK_ai_interview_questions_interview",
  })
  interview!: AiInterview;

  @Column({ type: "int" })
  position!: number;

  @Column({ type: "boolean", name: "is_follow_up", default: false })
  isFollowUp!: boolean;

  @Column({ type: "text" })
  question!: string;

  @Column({ type: "varchar", length: 255, name: "recording_key", nullable: true, default: null })
  recordingKey!: string | null;

  /** The question read aloud, made the first time the candidate plays it and reused after. */
  @Column({ type: "varchar", length: 255, name: "audio_key", nullable: true, default: null })
  audioKey!: string | null;

  @Column({
    type: "varchar",
    length: 100,
    name: "recording_mime_type",
    nullable: true,
    default: null,
  })
  recordingMimeType!: string | null;

  @Column({ type: "int", name: "recording_size", nullable: true, default: null })
  recordingSize!: number | null;

  @Column({ type: "timestamptz", name: "recorded_at", nullable: true, default: null })
  recordedAt!: Date | null;

  @Column({
    type: "double precision",
    name: "recording_duration_seconds",
    nullable: true,
    default: null,
  })
  recordingDurationSeconds!: number | null;

  @Column({
    type: "varchar",
    length: 20,
    name: "transcript_status",
    nullable: true,
    default: null,
  })
  transcriptStatus!: AiInterviewTranscriptStatus | null;

  @Column({ type: "text", nullable: true, default: null })
  transcript!: string | null;

  @Column({ type: "timestamptz", name: "transcribed_at", nullable: true, default: null })
  transcribedAt!: Date | null;

  @Column({ type: "int", name: "transcript_attempts", default: 0 })
  transcriptAttempts!: number;

  @Column({ type: "timestamptz", name: "transcript_next_retry_at", nullable: true, default: null })
  transcriptNextRetryAt!: Date | null;

  @Column({ type: "timestamptz", name: "transcript_locked_at", nullable: true, default: null })
  transcriptLockedAt!: Date | null;

  @Column({ type: "text", name: "transcript_last_error", nullable: true, default: null })
  transcriptLastError!: string | null;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
