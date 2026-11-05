import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import type { Application } from "./Application.js";
import type { User } from "./User.js";

/**
 * The clock for one person at one step. It starts when the sweep first sees them there, because
 * no stage entry time is stored. Moving on closes it, and returning later never restarts it.
 */
@Entity("stuck_email_timers")
@Unique("UQ_stuck_email_timers_step", ["userId", "scopeKey", "stage"])
@Index("IDX_stuck_email_timers_open", ["closedAt", "stuckSince"])
export class StuckEmailTimer {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne("User", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id", foreignKeyConstraintName: "FK_stuck_email_timers_user" })
  user!: User;

  @Column({ type: "uuid", name: "application_id", nullable: true })
  applicationId!: string | null;

  @ManyToOne("Application", { eager: false, onDelete: "CASCADE", nullable: true })
  @JoinColumn({
    name: "application_id",
    foreignKeyConstraintName: "FK_stuck_email_timers_application",
  })
  application!: Application | null;

  /** "onboarding", or "application:<id>" so each application has its own timers. */
  @Column({ type: "varchar", length: 64, name: "scope_key" })
  scopeKey!: string;

  @Column({ type: "varchar", length: 32 })
  stage!: string;

  @CreateDateColumn({ type: "timestamptz", name: "stuck_since" })
  stuckSince!: Date;

  @Column({ type: "timestamptz", name: "first_sent_at", nullable: true })
  firstSentAt!: Date | null;

  @Column({ type: "timestamptz", name: "second_sent_at", nullable: true })
  secondSentAt!: Date | null;

  @Column({ type: "timestamptz", name: "claimed_at", nullable: true })
  claimedAt!: Date | null;

  @Column({ type: "int", default: 0 })
  attempts!: number;

  @Column({ type: "text", name: "last_error", nullable: true })
  lastError!: string | null;

  @Column({ type: "timestamptz", name: "closed_at", nullable: true })
  closedAt!: Date | null;
}
