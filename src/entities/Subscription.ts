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
import { SubscriptionStatus } from "../types/enums.js";
import type { User } from "./User.js";
import type { Plan } from "./Plan.js";
import type { Organization } from "./Organization.js";

@Entity("subscriptions")
export class Subscription {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Who purchased/manages this on the organization's behalf — audit trail, not the entitlement key. */
  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "user_id" })
  user!: User;

  /** The organization this subscription actually belongs to — billing is company-wide, not per-user. */
  @Column({ type: "uuid", name: "organization_id" })
  @Index("IDX_subscriptions_organization_id")
  organizationId!: string;

  @ManyToOne("Organization", { eager: false })
  @JoinColumn({ name: "organization_id" })
  organization!: Organization;

  @Column({ type: "uuid", name: "plan_id" })
  planId!: string;

  @ManyToOne("Plan", { eager: false })
  @JoinColumn({ name: "plan_id" })
  plan!: Plan;

  @Column({ type: "varchar" })
  paystackSubscriptionCode!: string;

  @Column({ type: "varchar", nullable: true, default: null })
  authorizationCode!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  email_token!: string | null;

  @Column({ type: "enum", enum: SubscriptionStatus, default: SubscriptionStatus.Active })
  @Index()
  status!: SubscriptionStatus;

  @Column({ type: "timestamp", nullable: true, default: null })
  startDate!: Date | null;

  @Column({ type: "timestamp", nullable: true, default: null })
  nextPaymentDate!: Date | null;

  @Column({ type: "timestamp", nullable: true, default: null })
  expiryDate!: Date | null;

  @Column({ type: "varchar", nullable: true, default: null })
  cron_expression!: string | null;

  @Column({
    type: "jsonb",
    // Key order matches jsonb's canonical on-disk representation (Postgres
    // reorders object keys internally), and no explicit ::jsonb cast (TypeORM
    // strips casts off the introspected DB default before comparing) —
    // both must match exactly or the schema diff reports a false mismatch.
    default: () => `'{"aiTestsUsed": 0, "jobListingsUsed": 0, "candidatesAccessed": 0}'`,
  })
  usage!: {
    jobListingsUsed: number;
    candidatesAccessed: number;
    aiTestsUsed: number;
    lastResetDate?: Date;
  };

  @Column({ type: "jsonb", nullable: true, default: null })
  history!: Array<{ description: string; author: string; date: Date; action?: string }> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
