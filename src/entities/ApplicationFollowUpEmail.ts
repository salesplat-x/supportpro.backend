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

export type ApplicationFollowUpEmailStatus = "sent" | "failed";

/** A follow-up email an admin sent to a talent stuck mid-way through one job's
 * screening pipeline, sent or failed. `step` is the 1-based ordinal of this
 * follow-up for this application — "Step 1", "Step 2" in the admin timeline. */
@Entity("application_follow_up_emails")
@Index("IDX_app_follow_up_emails_app_created", ["applicationId", "createdAt"])
@Unique("UQ_app_follow_up_emails_app_step", ["applicationId", "step"])
export class ApplicationFollowUpEmail {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "application_id" })
  applicationId!: string;

  @ManyToOne("Application", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "application_id" })
  application!: Application;

  @Column({ type: "uuid", name: "sent_by_id", nullable: true })
  sentById!: string | null;

  @ManyToOne("User", { onDelete: "SET NULL", eager: false, nullable: true })
  @JoinColumn({ name: "sent_by_id" })
  sentBy!: User | null;

  @Column({ type: "int" })
  step!: number;

  /** The screening stage the application was stuck at when this was sent. */
  @Column({ type: "varchar", length: 32 })
  stage!: string;

  /** Application.updatedAt at send time — lets followUpStatus() tell "emailed, no
   * change yet" from "progressed" without re-deriving stage history. */
  @Column({ type: "timestamp", name: "application_updated_at_snapshot" })
  applicationUpdatedAtSnapshot!: Date;

  @Column({ type: "varchar", length: 200 })
  subject!: string;

  @Column({ type: "text" })
  body!: string;

  @Column({ type: "varchar", length: 16 })
  status!: ApplicationFollowUpEmailStatus;

  @Column({ type: "text", nullable: true, default: null })
  error!: string | null;

  /** "auto" for the stuck-user timer, so the admin screens can tell the two apart. */
  @Column({ type: "varchar", length: 16, default: "admin" })
  source!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
