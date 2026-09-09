import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import type { User } from "./User.js";
import type { Organization } from "./Organization.js";

export enum OrganizationJoinRequestStatus {
  Pending = "pending",
  Approved = "approved",
  Rejected = "rejected",
}

@Entity("organization_join_requests")
@Index("idx_org_join_requests_user_org", ["userId", "organizationId"])
export class OrganizationJoinRequest {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne("User", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "organization_id" })
  organization!: Organization;

  @Column({ type: "varchar", name: "work_email" })
  workEmail!: string;

  @Column({
    type: "varchar",
    default: OrganizationJoinRequestStatus.Pending,
  })
  status!: OrganizationJoinRequestStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
