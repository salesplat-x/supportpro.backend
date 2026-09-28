import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { Organization } from "./Organization.js";
import { BillingInterval, PlanChangeReason } from "../types/enums.js";

/** One row per change of an organization's billing plan; renewals of the same plan are not recorded. */
@Entity("organization_plan_history")
@Index("IDX_organization_plan_history_org_created", ["organizationId", "createdAt"])
export class OrganizationPlanHistory {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "organization_id" })
  organization!: Organization;

  @Column({ type: "varchar", length: 64, name: "from_plan", nullable: true })
  fromPlan!: string | null;

  @Column({ type: "varchar", length: 64, name: "to_plan" })
  toPlan!: string;

  @Column({
    type: "enum",
    enum: BillingInterval,
    enumName: "plans_interval_enum",
    nullable: true,
    name: "billing_interval",
  })
  billingInterval!: BillingInterval | null;

  @Column({ type: "varchar", length: 32 })
  reason!: PlanChangeReason;

  @Column({ type: "uuid", name: "payment_id", nullable: true })
  paymentId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
