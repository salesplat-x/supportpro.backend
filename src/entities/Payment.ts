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
import { PaymentStatus } from "../types/enums.js";
import type { User } from "./User.js";
import type { Plan } from "./Plan.js";

@Entity("payments")
export class Payment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "uuid", nullable: true, default: null, name: "plan_id" })
  planId!: string | null;

  @ManyToOne("Plan", { nullable: true, eager: false })
  @JoinColumn({ name: "plan_id" })
  plan!: Plan | null;

  @Column({ type: "float" })
  amount!: number;

  @Column({ type: "varchar" })
  currency!: string;

  @Column({ type: "varchar", nullable: true, default: null })
  reference!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  paystackRef!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  paymentLink!: string | null;

  @Column({ type: "enum", enum: PaymentStatus, default: PaymentStatus.Pending })
  @Index()
  status!: PaymentStatus;

  @Column({ type: "jsonb", nullable: true, default: null })
  history!: Array<{ description: string; author: string; date: Date }> | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  initialConfig!: Record<string, unknown> | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  finalConfig!: Record<string, unknown> | null;

  @Column({ type: "timestamp", nullable: true, default: null })
  paidAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
