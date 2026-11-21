import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { StaffMember } from "./StaffMember.js";

export const TASK_OWNERS = ["it", "new_hire", "manager", "hr"] as const;
export type TaskOwner = (typeof TASK_OWNERS)[number];

@Entity("staff_checklist_tasks")
@Index("IDX_staff_checklist_tasks_staff", ["staffId"])
export class StaffChecklistTask {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_checklist_tasks_staff" })
  staff!: StaffMember;

  @Column({ type: "varchar", length: 120 })
  title!: string;

  @Column({ type: "varchar", length: 200, nullable: true })
  description!: string | null;

  @Column({ type: "varchar", length: 16, nullable: true })
  owner!: TaskOwner | null;

  @Column({ type: "date", name: "due_on", nullable: true })
  dueOn!: string | null;

  @Column({ type: "timestamp", name: "done_at", nullable: true })
  doneAt!: Date | null;

  @Column({ type: "varchar", length: 241, name: "completed_by_name", nullable: true })
  completedByName!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
