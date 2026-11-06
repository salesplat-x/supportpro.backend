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

@Entity("staff_monthly_feedback")
@Check("CHK_staff_monthly_feedback_rating", `"rating" BETWEEN 1 AND 5`)
@Index("UQ_staff_monthly_feedback_staff_month", ["staffId", "month"], { unique: true })
export class StaffMonthlyFeedback {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({
    name: "organization_id",
    foreignKeyConstraintName: "FK_staff_monthly_feedback_org",
  })
  organization!: Organization;

  @Column({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_monthly_feedback_staff" })
  staff!: StaffMember;

  /** The first day of the month it is about. */
  @Column({ type: "date" })
  month!: string;

  @Column({ type: "smallint" })
  rating!: number;

  @Column({ type: "text" })
  notes!: string;

  @Column({ type: "varchar", length: 241, name: "by_name" })
  byName!: string;

  @Column({ type: "integer", default: 1 })
  version!: number;

  @Column({ type: "timestamptz", name: "updated_at" })
  updatedAt!: Date;
}
