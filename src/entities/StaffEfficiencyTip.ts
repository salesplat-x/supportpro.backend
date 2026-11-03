import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from "typeorm";
import type { StaffMember } from "./StaffMember.js";

@Entity("staff_efficiency_tips")
export class StaffEfficiencyTip {
  @PrimaryColumn({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_efficiency_tips_staff" })
  staff!: StaffMember;

  /** A fingerprint of the numbers the tip was written from. New numbers mean a new tip is on offer. */
  @Column({ type: "varchar", length: 64, name: "inputs_hash" })
  inputsHash!: string;

  @Column({ type: "text" })
  tip!: string;

  @Column({ type: "timestamptz", name: "updated_at" })
  updatedAt!: Date;
}
