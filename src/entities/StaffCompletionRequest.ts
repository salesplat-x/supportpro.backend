import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import type { StaffChecklistTask } from "./StaffChecklistTask.js";
import type { StaffGoal } from "./StaffGoal.js";
import type { StaffMember } from "./StaffMember.js";
import type { User } from "./User.js";

export enum CompletionRequestStatus {
  Pending = "pending",
  Approved = "approved",
  Returned = "returned",
  Withdrawn = "withdrawn",
}

export interface CompletionEvidenceFile {
  id: string;
  key: string;
  name: string;
  mimeType: string;
  size: number;
}

/** An employee's request that a goal or first-week task be marked complete, with their evidence. */
@Entity("staff_completion_requests")
@Check("CHK_staff_completion_requests_item", `num_nonnulls("goal_id", "task_id") = 1`)
@Index("IDX_staff_completion_requests_staff", ["staffId", "status"])
@Index("UQ_staff_completion_requests_goal_pending", ["goalId"], {
  unique: true,
  where: `"goal_id" IS NOT NULL AND "status" = 'pending'`,
})
@Index("UQ_staff_completion_requests_task_pending", ["taskId"], {
  unique: true,
  where: `"task_id" IS NOT NULL AND "status" = 'pending'`,
})
export class StaffCompletionRequest {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_completion_requests_staff" })
  staff!: StaffMember;

  @Column({ type: "uuid", name: "goal_id", nullable: true })
  goalId!: string | null;

  @ManyToOne("StaffGoal", { eager: false, onDelete: "CASCADE", nullable: true })
  @JoinColumn({ name: "goal_id", foreignKeyConstraintName: "FK_staff_completion_requests_goal" })
  goal!: StaffGoal | null;

  @Column({ type: "uuid", name: "task_id", nullable: true })
  taskId!: string | null;

  @ManyToOne("StaffChecklistTask", { eager: false, onDelete: "CASCADE", nullable: true })
  @JoinColumn({ name: "task_id", foreignKeyConstraintName: "FK_staff_completion_requests_task" })
  task!: StaffChecklistTask | null;

  @Column({ type: "text" })
  summary!: string;

  @Column({ type: "jsonb", default: () => "'[]'" })
  links!: string[];

  @Column({ type: "jsonb", default: () => "'[]'" })
  files!: CompletionEvidenceFile[];

  @Column({ type: "varchar", length: 16, default: CompletionRequestStatus.Pending })
  status!: CompletionRequestStatus;

  @Column({ type: "text", name: "review_note", nullable: true })
  reviewNote!: string | null;

  @Column({ type: "varchar", length: 241, name: "reviewed_by_name", nullable: true })
  reviewedByName!: string | null;

  @Column({ type: "timestamptz", name: "reviewed_at", nullable: true })
  reviewedAt!: Date | null;

  @Column({ type: "uuid", name: "submitted_by_id", nullable: true })
  submittedById!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({
    name: "submitted_by_id",
    foreignKeyConstraintName: "FK_staff_completion_requests_submitted_by",
  })
  submittedBy!: User | null;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
