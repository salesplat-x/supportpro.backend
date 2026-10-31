import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
  Check,
} from "typeorm";
import { numericColumn } from "./PayPackage.js";
import type { StaffMember } from "./StaffMember.js";

@Entity("share_grants")
@Check("CHK_share_grants_shares_positive", `"shares" > 0`)
@Check(
  "CHK_share_grants_schedule",
  `"vesting_months" >= 1 AND "cliff_months" >= 0 AND "cliff_months" <= "vesting_months"`
)
@Index("IDX_share_grants_staff", ["staffId"])
export class ShareGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_share_grants_staff" })
  staff!: StaffMember;

  @Column({ type: "integer" })
  shares!: number;

  @Column({ type: "date", name: "granted_on" })
  grantedOn!: string;

  @Column({ type: "integer", name: "cliff_months" })
  cliffMonths!: number;

  @Column({ type: "integer", name: "vesting_months" })
  vestingMonths!: number;

  @Column({
    type: "numeric",
    precision: 14,
    scale: 2,
    name: "strike_price",
    transformer: numericColumn,
  })
  strikePrice!: number;

  @Column({ type: "varchar", length: 3 })
  currency!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
