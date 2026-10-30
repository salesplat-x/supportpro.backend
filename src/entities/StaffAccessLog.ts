import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { User } from "./User.js";
import type { Organization } from "./Organization.js";
import type { StaffMember } from "./StaffMember.js";

export enum StaffAccessResource {
  StaffRecord = "staff_record",
  StaffActivity = "staff_activity",
  Pay = "pay",
}

/** One row per time someone opens a staff member's data. Rows are never edited or deleted. */
@Entity("staff_access_logs")
@Index("IDX_staff_access_logs_org_created", ["organizationId", "createdAt"])
export class StaffAccessLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_staff_access_logs_org" })
  organization!: Organization;

  @Column({ type: "uuid", name: "actor_id", nullable: true })
  actorId!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "actor_id", foreignKeyConstraintName: "FK_staff_access_logs_actor" })
  actor!: User | null;

  @Column({ type: "varchar", length: 241, name: "actor_name" })
  actorName!: string;

  @Column({ type: "uuid", name: "staff_id", nullable: true })
  staffId!: string | null;

  @ManyToOne("StaffMember", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_access_logs_staff" })
  staff!: StaffMember | null;

  @Column({ type: "varchar", length: 241, name: "staff_name" })
  staffName!: string;

  @Column({ type: "varchar", length: 32 })
  resource!: StaffAccessResource;

  @Column({ type: "varchar", length: 64, nullable: true })
  ip!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
