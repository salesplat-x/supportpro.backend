import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { User } from "./User.js";
import type { Organization } from "./Organization.js";
import type { StaffMember } from "./StaffMember.js";

export enum StaffActivityType {
  Created = "created",
  Invited = "invited",
  InviteResent = "invite_resent",
  InviteFailed = "invite_failed",
  InviteOpened = "invite_opened",
  Joined = "joined",
  Updated = "updated",
  Ended = "ended",
  PaySet = "pay_set",
  ShareGrantAdded = "share_grant_added",
  ShareGrantRemoved = "share_grant_removed",
  DocumentSent = "document_sent",
  DocumentEmailFailed = "document_email_failed",
  DocumentViewed = "document_viewed",
  DocumentSigned = "document_signed",
  DocumentCopyFailed = "document_copy_failed",
  DocumentNotarized = "document_notarized",
  JobDescriptionSaved = "job_description_saved",
  GoalAdded = "goal_added",
  GoalsSuggested = "goals_suggested",
  GoalChanged = "goal_changed",
  GoalApproved = "goal_approved",
  GoalRemoved = "goal_removed",
  GoalProgressUpdated = "goal_progress_updated",
  WeeklyReportSubmitted = "weekly_report_submitted",
  ReportNoteAdded = "report_note_added",
  DevelopmentItemAdded = "development_item_added",
  DevelopmentItemRemoved = "development_item_removed",
  FeedbackSaved = "feedback_saved",
  HrAssigned = "hr_assigned",
  HrRemoved = "hr_removed",
}

/** Append-only history of what happens to one staff member. Rows are never edited or deleted. */
@Entity("staff_activities")
@Index("IDX_staff_activities_staff_created", ["staffId", "createdAt"])
export class StaffActivity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_staff_activities_org" })
  organization!: Organization;

  @Column({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_activities_staff" })
  staff!: StaffMember;

  @Column({ type: "uuid", name: "actor_id", nullable: true })
  actorId!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "actor_id", foreignKeyConstraintName: "FK_staff_activities_actor" })
  actor!: User | null;

  @Column({ type: "varchar", length: 241, name: "actor_name" })
  actorName!: string;

  @Column({ type: "varchar", length: 32 })
  type!: StaffActivityType;

  @Column({ type: "jsonb", nullable: true })
  meta!: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
