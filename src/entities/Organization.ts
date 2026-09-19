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
import { OrganizationStatus } from "../types/enums.js";
import type { User } from "./User.js";

@Entity("organizations")
@Index("IDX_organizations_domain_unique", ["domain"], {
  unique: true,
  where: `"domain" IS NOT NULL`,
})
export class Organization {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", nullable: true, default: null, name: "owner_id" })
  ownerId!: string | null;

  @ManyToOne("User", { nullable: true, eager: false })
  @JoinColumn({ name: "owner_id" })
  owner!: User | null;

  @Column({ type: "varchar", nullable: false })
  name!: string;

  @Column({ type: "varchar", nullable: true, default: null })
  email!: string | null;

  /** Normalized corporate domain, e.g. acme.com (no leading @). */
  @Column({ type: "varchar", nullable: true, default: null })
  domain!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  phone!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  address!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  industry!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  website!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  facebook!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  linkedin!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  twitter!: string | null;

  @Column({ type: "varchar", nullable: true, default: null, name: "logo_url" })
  logoUrl!: string | null;

  /** DigitalOcean Spaces object key — needed to delete the previous logo on replace/remove. */
  @Column({ type: "varchar", nullable: true, default: null, name: "logo_key" })
  logoKey!: string | null;

  @Column({ type: "enum", enum: OrganizationStatus, default: OrganizationStatus.Pending })
  status!: OrganizationStatus;

  @Column({ type: "timestamp", nullable: true, default: null, name: "verified_at" })
  verifiedAt!: Date | null;

  @Column({ type: "uuid", nullable: true, default: null, name: "verified_by_id" })
  verifiedById!: string | null;

  @ManyToOne("User", { nullable: true, eager: false })
  @JoinColumn({ name: "verified_by_id" })
  verifiedBy!: User | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
