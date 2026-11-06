import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { StaffGoal } from "./StaffGoal.js";

/** Each real change to a goal's progress. Capacity reads these to work out recent pace. */
@Entity("staff_goal_progress_events")
@Index("IDX_staff_goal_progress_events_goal", ["goalId", "createdAt"])
export class StaffGoalProgressEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "goal_id" })
  goalId!: string;

  @ManyToOne("StaffGoal", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "goal_id", foreignKeyConstraintName: "FK_staff_goal_progress_events_goal" })
  goal!: StaffGoal;

  @Column({ type: "smallint", name: "from_progress" })
  fromProgress!: number;

  @Column({ type: "smallint", name: "to_progress" })
  toProgress!: number;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
