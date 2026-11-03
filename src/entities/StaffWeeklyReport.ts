import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from "typeorm";
import type { Organization } from "./Organization.js";
import type { StaffMember } from "./StaffMember.js";

@Entity("staff_weekly_reports")
@Index("UQ_staff_weekly_reports_staff_week", ["staffId", "weekStart"], { unique: true })
export class StaffWeeklyReport {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_staff_weekly_reports_org" })
  organization!: Organization;

  @Column({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_weekly_reports_staff" })
  staff!: StaffMember;

  @Column({ type: "date", name: "week_start" })
  weekStart!: string;

  @Column({ type: "text" })
  did!: string;

  @Column({ type: "text" })
  blocked!: string;

  @Column({ type: "text", name: "next_week" })
  nextWeek!: string;

  @Column({ type: "integer", name: "text_version", default: 1 })
  textVersion!: number;

  @Column({ type: "timestamptz", name: "submitted_at" })
  submittedAt!: Date;

  @Column({ type: "text", name: "manager_note", nullable: true })
  managerNote!: string | null;

  @Column({ type: "varchar", length: 241, name: "manager_note_by_name", nullable: true })
  managerNoteByName!: string | null;

  @Column({ type: "timestamptz", name: "manager_note_at", nullable: true })
  managerNoteAt!: Date | null;

  @Column({ type: "integer", name: "note_version", default: 0 })
  noteVersion!: number;

  @Column({ type: "jsonb", nullable: true })
  advice!: string[] | null;

  @Column({ type: "timestamptz", name: "advice_at", nullable: true })
  adviceAt!: Date | null;
}
