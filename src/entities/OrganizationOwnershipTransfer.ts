import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import type { Organization } from "./Organization.js";
import type { User } from "./User.js";

/** A record of an admin changing a company's creator. Names are kept in case an account is deleted. */
@Entity("organization_ownership_transfers")
@Index("IDX_organization_ownership_transfers_org", ["organizationId", "createdAt"])
export class OrganizationOwnershipTransfer {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({
    name: "organization_id",
    foreignKeyConstraintName: "FK_organization_ownership_transfers_org",
  })
  organization!: Organization;

  @Column({ type: "uuid", name: "from_user_id", nullable: true })
  fromUserId!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({
    name: "from_user_id",
    foreignKeyConstraintName: "FK_organization_ownership_transfers_from",
  })
  fromUser!: User | null;

  @Column({ type: "uuid", name: "to_user_id", nullable: true })
  toUserId!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({
    name: "to_user_id",
    foreignKeyConstraintName: "FK_organization_ownership_transfers_to",
  })
  toUser!: User | null;

  @Column({ type: "uuid", name: "admin_id", nullable: true })
  adminId!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({
    name: "admin_id",
    foreignKeyConstraintName: "FK_organization_ownership_transfers_admin",
  })
  admin!: User | null;

  @Column({ type: "varchar", length: 241, name: "from_name" })
  fromName!: string;

  @Column({ type: "varchar", length: 241, name: "to_name" })
  toName!: string;

  @Column({ type: "text" })
  reason!: string;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
