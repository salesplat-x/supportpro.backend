import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import type { User } from "./User.js";

export type OnboardingEmailStatus = "sent" | "failed";

/** A follow-up email an admin sent to a user stuck in onboarding, sent or failed. */
@Entity("onboarding_emails")
@Index("IDX_onboarding_emails_user_created", ["userId", "createdAt"])
export class OnboardingEmail {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne("User", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "uuid", name: "sent_by_id", nullable: true })
  sentById!: string | null;

  @ManyToOne("User", { onDelete: "SET NULL", eager: false, nullable: true })
  @JoinColumn({ name: "sent_by_id" })
  sentBy!: User | null;

  /** The user's onboarding stage when the email was sent. */
  @Column({ type: "varchar", length: 32 })
  stage!: string;

  @Column({ type: "varchar", length: 200 })
  subject!: string;

  @Column({ type: "text" })
  body!: string;

  @Column({ type: "varchar", length: 16 })
  status!: OnboardingEmailStatus;

  @Column({ type: "text", nullable: true, default: null })
  error!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
