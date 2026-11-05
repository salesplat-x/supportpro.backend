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
import type { StaffMember } from "./StaffMember.js";
import type { User } from "./User.js";

/**
 * A teammate the creator picked to track one employee's performance and activity. The company
 * comes from the staff row, so an assignment can't point at a different company from its staff.
 */
@Entity("staff_hr_assignments")
@Unique("UQ_staff_hr_assignments_pair", ["staffId", "assigneeUserId"])
@Index("IDX_staff_hr_assignments_assignee", ["assigneeUserId"])
export class StaffHrAssignment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_hr_assignments_staff" })
  staff!: StaffMember;

  @Column({ type: "uuid", name: "assignee_user_id" })
  assigneeUserId!: string;

  @ManyToOne("User", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({
    name: "assignee_user_id",
    foreignKeyConstraintName: "FK_staff_hr_assignments_assignee",
  })
  assignee!: User;

  @Column({ type: "uuid", name: "assigned_by_id", nullable: true })
  assignedById!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({
    name: "assigned_by_id",
    foreignKeyConstraintName: "FK_staff_hr_assignments_assigned_by",
  })
  assignedBy!: User | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
