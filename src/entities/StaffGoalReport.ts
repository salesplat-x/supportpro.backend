import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
} from "typeorm";
import type { Organization } from "./Organization.js";
import type { StaffMember } from "./StaffMember.js";
import type { StaffGoal } from "./StaffGoal.js";
import type { CompletionEvidenceFile } from "./StaffCompletionRequest.js";
import type { ReportFrequency } from "../utils/workCalendar.js";

/** One report on one goal for one day, week or month. It can change until a reviewer replies. */
@Entity("staff_goal_reports")
@Check("CHK_staff_goal_reports_frequency", `"frequency" IN ('daily', 'weekly', 'monthly')`)
@Index("UQ_staff_goal_reports_period", ["goalId", "periodStart"], { unique: true })
@Index("IDX_staff_goal_reports_staff_submitted", ["staffId", "submittedAt"])
export class StaffGoalReport {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_staff_goal_reports_org" })
  organization!: Organization;

  @Column({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_goal_reports_staff" })
  staff!: StaffMember;

  @Column({ type: "uuid", name: "goal_id" })
  goalId!: string;

  @ManyToOne("StaffGoal", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "goal_id", foreignKeyConstraintName: "FK_staff_goal_reports_goal" })
  goal!: StaffGoal;

  @Column({ type: "varchar", length: 16 })
  frequency!: ReportFrequency;

  @Column({ type: "date", name: "period_start" })
  periodStart!: string;

  @Column({ type: "text", nullable: true })
  text!: string | null;

  @Column({ type: "jsonb", default: () => "'[]'" })
  links!: string[];

  @Column({ type: "jsonb", default: () => "'[]'" })
  files!: CompletionEvidenceFile[];

  @Column({ type: "integer", name: "text_version", default: 1 })
  textVersion!: number;

  @Column({ type: "timestamptz", name: "submitted_at" })
  submittedAt!: Date;

  @Column({ type: "text", name: "reviewer_note", nullable: true })
  reviewerNote!: string | null;

  @Column({ type: "varchar", length: 241, name: "reviewer_note_by_name", nullable: true })
  reviewerNoteByName!: string | null;

  @Column({ type: "timestamptz", name: "reviewer_note_at", nullable: true })
  reviewerNoteAt!: Date | null;

  @Column({ type: "integer", name: "note_version", default: 0 })
  noteVersion!: number;
}
