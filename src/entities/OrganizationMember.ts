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

@Entity("organization_members")
@Index("idx_org_members_user_org", ["userId", "organizationId"], { unique: true })
export class OrganizationMember {
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

  @Column({ type: "varchar", default: "member" })
  role!: string;

  @Column({ type: "boolean", name: "can_manage_people", default: false })
  canManagePeople!: boolean;

  /** Job title the owner gives this member, e.g. "HR lead". */
  @Column({ type: "varchar", length: 60, nullable: true })
  title!: string | null;

  /** When this member last asked the owner for access to People; at most one ask a day. */
  @Column({ type: "timestamptz", name: "people_access_requested_at", nullable: true })
  peopleAccessRequestedAt!: Date | null;

  @Column({ type: "timestamp", default: () => "CURRENT_TIMESTAMP", name: "verified_at" })
  verifiedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
