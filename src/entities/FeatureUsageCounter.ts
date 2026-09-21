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
import type { Organization } from "./Organization.js";

/**
 * Rolling monthly usage counter for a gated, org-shared feature (e.g. candidate_views).
 * Concurrent-count features (job_listings, team_members) don't use this table — they're
 * checked live against the real rows instead, so they can never drift.
 */
@Entity("feature_usage_counters")
@Index(
  "UQ_feature_usage_counters_org_feature_period",
  ["organizationId", "featureKey", "periodStart"],
  {
    unique: true,
  }
)
export class FeatureUsageCounter {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false })
  @JoinColumn({ name: "organization_id" })
  organization!: Organization;

  @Column({ type: "varchar", length: 64, name: "feature_key" })
  featureKey!: string;

  /** First day of the counting window (calendar month) — a lazy reset just inserts a new row. */
  @Column({ type: "date", name: "period_start" })
  periodStart!: string;

  @Column({ type: "int", default: 0 })
  count!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
