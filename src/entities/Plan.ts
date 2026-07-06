import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import { BillingInterval, Currency } from "../types/enums.js";

@Entity("plans")
export class Plan {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

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
