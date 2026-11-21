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
@Index("IDX_organizations_access_code_unique", ["accessCode"], {
  unique: true,
  where: `"access_code" IS NOT NULL`,
})
export class Organization {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", nullable: true, default: null, name: "owner_id" })
  ownerId!: string | null;

  /** Teammates join with this. Never selected by default, so company payloads never carry it. */
  @Column({ type: "varchar", length: 9, nullable: true, name: "access_code", select: false })
  accessCode!: string | null;

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

  /** Superseded by company_values_text; still written so a rollback keeps the values. */
  @Column({ type: "jsonb", default: "[]", name: "company_values", select: false })
  legacyCompanyValues!: string[];

  @Column({ type: "text", nullable: true, default: null, name: "company_values_text" })
  companyValues!: string | null;

  @Column({ type: "varchar", length: 16, nullable: true })
  size!: string | null;

  @Column({ type: "text", nullable: true, default: null })
  about!: string | null;

  @Column({ type: "int", nullable: true, default: null, name: "founded_year" })
  foundedYear!: number | null;

  @Column({ type: "text", nullable: true })
  mission!: string | null;

  @Column({ type: "text", nullable: true })
  vision!: string | null;

  @Column({ type: "jsonb", default: "[]" })
  departments!: string[];

  /** Open jobs are published in a public Indeed XML feed while this is on. */
  @Column({ type: "boolean", default: false, name: "indeed_feed_enabled" })
  indeedFeedEnabled!: boolean;

  /** Set the first time the feed is turned on and never changed, so the link pasted into job sites keeps working. */
  @Index("IDX_organizations_feed_slug", { unique: true })
  @Column({ type: "varchar", length: 80, nullable: true, name: "feed_slug" })
  feedSlug!: string | null;

  @Column({ type: "jsonb", default: "[]", name: "yearly_goals" })
  yearlyGoals!: string[];

  @Column({ type: "jsonb", nullable: true, name: "default_checklist" })
  defaultChecklist!:
    | {
        title: string;
        dueInDays: number;
        description?: string | null;
        owner?: "it" | "new_hire" | "manager" | "hr" | null;
      }[]
    | null;

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
