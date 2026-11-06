import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Check,
} from "typeorm";
import type { User } from "./User.js";

export const FEEDBACK_TOPICS = [
  "account",
  "billing",
  "jobs",
  "applications",
  "bug",
  "idea",
  "other",
] as const;
export type FeedbackTopic = (typeof FEEDBACK_TOPICS)[number];

export const FEEDBACK_TEXT_MAX_LENGTH = 5000;

export const REPLY_EMAIL_STATUSES = ["pending", "sent", "failed"] as const;
export type ReplyEmailStatus = (typeof REPLY_EMAIL_STATUSES)[number];

@Entity("feedback")
@Index("IDX_feedback_user_id_createdAt", ["userId", "createdAt"])
@Index("IDX_feedback_isRead", ["isRead"])
@Index("IDX_feedback_replied_at_createdAt", ["repliedAt", "createdAt"])
@Index("UQ_feedback_user_client_request", ["userId", "clientRequestId"], {
  unique: true,
  where: '"client_request_id" IS NOT NULL',
})
@Check(
  "CHK_feedback_topic",
  `"topic" IN ('account', 'billing', 'jobs', 'applications', 'bug', 'idea', 'other')`
)
@Check("CHK_feedback_reply_email_status", `"reply_email_status" IN ('pending', 'sent', 'failed')`)
export class Feedback {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne("User", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id", foreignKeyConstraintName: "FK_feedback_user" })
  user!: User;

  @Column({ type: "varchar", nullable: true, default: null })
  subject!: string | null;

  @Column({ type: "text" })
  message!: string;

  @Column({ type: "varchar", length: 32, nullable: true })
  topic!: FeedbackTopic | null;

  /** Set by the sender's browser so a retried submit returns the first request instead of a copy. */
  @Column({ type: "uuid", name: "client_request_id", nullable: true })
  clientRequestId!: string | null;

  @Column({ default: false })
  isRead!: boolean;

  @Column({ type: "text", nullable: true })
  reply!: string | null;

  @Column({ type: "timestamptz", name: "replied_at", nullable: true })
  repliedAt!: Date | null;

  @Column({ type: "uuid", name: "replied_by_id", nullable: true })
  repliedById!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "replied_by_id", foreignKeyConstraintName: "FK_feedback_replied_by" })
  repliedBy!: User | null;

  @Column({ type: "varchar", length: 16, name: "reply_email_status", nullable: true })
  replyEmailStatus!: ReplyEmailStatus | null;

  @Column({ type: "text", name: "reply_email_error", nullable: true })
  replyEmailError!: string | null;

  /** The admin's unsent reply. Only the admin writes it. */
  @Column({ type: "text", name: "draft_reply", nullable: true })
  draftReply!: string | null;

  @Column({ type: "timestamptz", name: "draft_updated_at", nullable: true })
  draftUpdatedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt!: Date;
}
