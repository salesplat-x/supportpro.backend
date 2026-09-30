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

export enum OrganizationInviteStatus {
  Pending = "pending",
  Accepted = "accepted",
  Revoked = "revoked",
  Expired = "expired",
}

@Entity("organization_invites")
@Index("idx_org_invites_token", ["token"], { unique: true })
@Index("idx_org_invites_org_email", ["organizationId", "email"])
export class OrganizationInvite {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_org_invites_org" })
  organization!: Organization;

  @Column({ type: "varchar" })
  email!: string;

  @Column({ type: "varchar" })
  token!: string;

  @Column({ type: "uuid", name: "invited_by_id" })
  invitedById!: string;

  @ManyToOne("User", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "invited_by_id", foreignKeyConstraintName: "FK_org_invites_invited_by" })
  invitedBy!: User;

  @Column({
    type: "varchar",
    default: OrganizationInviteStatus.Pending,
  })
  status!: OrganizationInviteStatus;

  @Column({ type: "timestamp", name: "expires_at" })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
