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

  @Column({ type: "date", name: "due_on", nullable: true })
  dueOn!: string | null;

  @Column({ type: "timestamp", name: "done_at", nullable: true })
  doneAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
