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

  @Column({ type: "jsonb" })
  tiers!: CommissionTier[];

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
