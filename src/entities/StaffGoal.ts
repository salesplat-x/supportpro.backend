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

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
