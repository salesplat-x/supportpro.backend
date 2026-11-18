import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  type ValueTransformer,
} from "typeorm";
import type { Benefit } from "./Benefit.js";
import type { CommissionPlan } from "./CommissionPlan.js";
import type { StaffMember } from "./StaffMember.js";
import type { User } from "./User.js";

export enum PayPeriod {
  Monthly = "monthly",
  Yearly = "yearly",
}

export const numericColumn: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity("pay_packages")
@Index("UQ_pay_packages_staff_starts_on", ["staffId", "startsOn"], { unique: true })
export class PayPackage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_pay_packages_staff" })
  staff!: StaffMember;

  @Column({ type: "varchar", length: 3 })
  currency!: string;

  @Column({ type: "varchar", length: 16 })
  period!: PayPeriod;

  @Column({
    type: "numeric",
    precision: 14,
    scale: 2,
    name: "base_salary",
    transformer: numericColumn,
  })
  baseSalary!: number;

  @Column({ type: "numeric", precision: 14, scale: 2, default: 0, transformer: numericColumn })
  bonus!: number;

  @Column({
    type: "numeric",
    precision: 14,
    scale: 2,
    name: "commission_target",
    default: 0,
    transformer: numericColumn,
  })
  commissionTarget!: number;

  /** False on rows saved before bonus and target were always yearly; see yearlyExtras. */
  @Column({ type: "boolean", name: "extras_yearly", default: false })
  extrasYearly!: boolean;

  @Column({ type: "date", name: "starts_on" })
  startsOn!: string;

  @Column({ type: "uuid", name: "commission_plan_id", nullable: true })
  commissionPlanId!: string | null;

  @ManyToOne("CommissionPlan", { eager: false, onDelete: "NO ACTION", nullable: true })
  @JoinColumn({
    name: "commission_plan_id",
    foreignKeyConstraintName: "FK_pay_packages_commission_plan",
  })
  commissionPlan!: CommissionPlan | null;

  @ManyToMany("Benefit", { eager: false })
  @JoinTable({
    name: "pay_package_benefits",
    joinColumn: {
      name: "pay_package_id",
      referencedColumnName: "id",
      foreignKeyConstraintName: "FK_pay_package_benefits_package",
    },
    inverseJoinColumn: {
      name: "benefit_id",
      referencedColumnName: "id",
      foreignKeyConstraintName: "FK_pay_package_benefits_benefit",
    },
  })
  benefits!: Benefit[];

  @Column({ type: "uuid", name: "created_by_id", nullable: true })
  createdById!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "created_by_id", foreignKeyConstraintName: "FK_pay_packages_created_by" })
  createdBy!: User | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
