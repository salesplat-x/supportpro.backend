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

export interface CommissionTier {
  fromPercent: number;
  toPercent: number | null;
  ratePercent: number;
  boost: number | null;
}

export interface CommissionBand {
  fromAmount: number;
  toAmount: number | null;
  ratePercent: number;
}

export enum CommissionPaidOn {
  YearlySales = "yearly_sales",
  ProductRevenue = "product_revenue",
  Renewals = "renewals",
}

export enum CommissionFrequency {
  Monthly = "monthly",
  Quarterly = "quarterly",
  Yearly = "yearly",
}

@Entity("commission_plans")
@Index("UQ_commission_plans_org_name", ["organizationId", "name"], { unique: true })
export class CommissionPlan {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_commission_plans_org" })
  organization!: Organization;

  @Column({ type: "varchar", length: 120 })
  name!: string;

  @Column({ type: "jsonb", default: () => "'[]'" })
  tiers!: CommissionTier[];

  @Column({ type: "jsonb", nullable: true })
  bands!: CommissionBand[] | null;

  @Column({ type: "varchar", length: 32, name: "paid_on", nullable: true })
  paidOn!: CommissionPaidOn | null;

  @Column({ type: "varchar", length: 16, nullable: true })
  frequency!: CommissionFrequency | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
