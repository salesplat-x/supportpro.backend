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
import {
  BillingInterval,
  BillingStatus,
  DEFAULT_BILLING_PLAN_KEY,
  OrganizationStatus,
} from "../types/enums.js";
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

  /**
   * The company's values, in the recruiter's own words (e.g. "Ownership").
   * Culture-fit questions are written against these. At most
   * MAX_COMPANY_VALUES entries of up to MAX_COMPANY_VALUE_LENGTH characters.
   */
  @Column({ type: "jsonb", default: "[]", name: "company_values" })
  companyValues!: string[];

  /** Day 8: when on, the company's open jobs are published at GET /v1/organizations/:id/jobs.xml for Indeed. */
  @Column({ type: "boolean", default: false, name: "indeed_feed_enabled" })
  indeedFeedEnabled!: boolean;

  @Column({ type: "enum", enum: OrganizationStatus, default: OrganizationStatus.Pending })
  status!: OrganizationStatus;

  /** The plan is purchased for the whole company — shared by every recruiter who's a member. */
  @Column({
    type: "varchar",
    length: 64,
    default: DEFAULT_BILLING_PLAN_KEY,
    name: "billing_plan",
  })
  @Index("IDX_organizations_billing_plan")
  billingPlan!: string;

  @Column({
    type: "enum",
    enum: BillingInterval,
    enumName: "plans_interval_enum",
    nullable: true,
    default: null,
    name: "billing_interval",
  })
  billingInterval!: BillingInterval | null;

  @Column({
    type: "enum",
    enum: BillingStatus,
    enumName: "users_billingstatus_enum",
    default: BillingStatus.Active,
    name: "billing_status",
  })
  billingStatus!: BillingStatus;

  /** When the current paid subscription period ends; null on pay_per_use. */
  @Column({ type: "timestamp", nullable: true, default: null, name: "billing_period_end" })
  billingPeriodEnd!: Date | null;

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
