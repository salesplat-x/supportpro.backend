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
import type { Organization } from "./Organization.js";
import type { StaffMember } from "./StaffMember.js";
import type { ReportFrequency } from "../utils/workCalendar.js";

export enum GoalStatus {
  Draft = "draft",
  Approved = "approved",
}

export enum GoalSource {
  Manual = "manual",
  Ai = "ai",
}

@Entity("staff_goals")
@Check("CHK_staff_goals_progress", `"progress" BETWEEN 0 AND 100`)
@Check("CHK_staff_goals_approved", `("status" = 'approved') = ("approved_at" IS NOT NULL)`)
@Check(
  "CHK_staff_goals_completed",
  `("progress" = 100) = ("completed_at" IS NOT NULL) AND ("completed_at" IS NULL OR "status" = 'approved')`
)
@Check(
  "CHK_staff_goals_report_frequency",
  `"report_frequency" IS NULL OR "report_frequency" IN ('daily', 'weekly', 'monthly')`
)
@Index("IDX_staff_goals_staff", ["staffId", "status"])
@Index("IDX_staff_goals_org", ["organizationId", "status"])
export class StaffGoal {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_staff_goals_org" })
  organization!: Organization;

  @Column({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_goals_staff" })
  staff!: StaffMember;

  @Column({ type: "varchar", length: 200 })
  title!: string;

  @Column({ type: "jsonb", name: "key_results", default: () => "'[]'" })
  keyResults!: string[];

  @Column({ type: "varchar", length: 200, nullable: true })
  target!: string | null;

  @Column({ type: "date", name: "due_on" })
  dueOn!: string;

  @Column({ type: "smallint", default: 0 })
  progress!: number;

  @Column({ type: "varchar", length: 16, default: GoalStatus.Draft })
  status!: GoalStatus;

  @Column({ type: "varchar", length: 16, default: GoalSource.Manual })
  source!: GoalSource;

  /** Changes when the goal's wording does. Progress and approval leave it alone, so neither makes someone's open form stale. */
  @Column({ type: "integer", default: 1 })
  version!: number;

  @Column({ type: "varchar", length: 241, name: "approved_by_name", nullable: true })
  approvedByName!: string | null;

  @Column({ type: "timestamptz", name: "approved_at", nullable: true })
  approvedAt!: Date | null;

  /** Set only by a reviewer. Reaching 100 and being complete are the same thing. */
  @Column({ type: "timestamptz", name: "completed_at", nullable: true })
  completedAt!: Date | null;

  @Column({ type: "varchar", length: 241, name: "completed_by_name", nullable: true })
  completedByName!: string | null;

  /** How often the employee reports on this goal. Null means no reports are expected. */
  @Column({ type: "varchar", length: 16, name: "report_frequency", nullable: true })
  reportFrequency!: ReportFrequency | null;

  /** The Lagos date the frequency was last set; missed periods count from here. */
  @Column({ type: "date", name: "report_frequency_since", nullable: true })
  reportFrequencySince!: string | null;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
