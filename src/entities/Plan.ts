import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import { BillingInterval, Currency } from "../types/enums.js";

@Entity("plans")
@Index("UQ_plans_key_interval", ["planKey", "interval"], {
  unique: true,
  where: `"isDeleted" = false`,
})
export class Plan {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Stable slug matching config/pricing.yaml's plan `key` — links this billing row back to the marketing catalogue. */
  @Column({ type: "varchar", length: 64, name: "plan_key" })
  planKey!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "float" })
  amount!: number;

  @Column({ type: "float" })
  paystackAmount!: number;

  @Column({ type: "enum", enum: BillingInterval })
  interval!: BillingInterval;

  @Column({ type: "varchar", nullable: true, default: null })
  paystackPlanCode!: string | null;

  @Column({ type: "enum", enum: Currency })
  currency!: Currency;

  @Column({ type: "boolean", nullable: true, default: null })
  update_existing_subscriptions!: boolean | null;

  @Column({ type: "text" })
  description!: string;

  @Column({ type: "simple-array", nullable: true, default: null })
  features!: string[] | null;

  @Column({ default: false })
  isDeleted!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
