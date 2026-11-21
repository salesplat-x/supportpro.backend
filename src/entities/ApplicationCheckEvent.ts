import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import type { CheckEventKind } from "../types/checks.js";
import type { Application } from "./Application.js";
import type { ApplicationCheck } from "./ApplicationCheck.js";
import type { User } from "./User.js";

@Entity("application_check_events")
@Index("IDX_application_check_events_check", ["checkId", "createdAt"])
export class ApplicationCheckEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "application_id" })
  applicationId!: string;

  @ManyToOne("Application", { onDelete: "CASCADE", eager: false })
  @JoinColumn({
    name: "application_id",
    foreignKeyConstraintName: "FK_application_check_events_application",
  })
  application!: Application;

  @Column({ type: "uuid", name: "check_id" })
  checkId!: string;

  @ManyToOne("ApplicationCheck", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "check_id", foreignKeyConstraintName: "FK_application_check_events_check" })
  check!: ApplicationCheck;

  @Column({ type: "uuid", name: "actor_id", nullable: true })
  actorId!: string | null;

  @ManyToOne("User", { onDelete: "SET NULL", nullable: true, eager: false })
  @JoinColumn({ name: "actor_id", foreignKeyConstraintName: "FK_application_check_events_actor" })
  actor!: User | null;

  @Column({ type: "varchar", length: 24 })
  kind!: CheckEventKind;

  @Column({ type: "varchar", length: 64, nullable: true, default: null })
  detail!: string | null;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
