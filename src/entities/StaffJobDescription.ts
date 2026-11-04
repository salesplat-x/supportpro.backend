import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, UpdateDateColumn } from "typeorm";
import type { StaffMember } from "./StaffMember.js";

@Entity("staff_job_descriptions")
export class StaffJobDescription {
  @PrimaryColumn({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_job_descriptions_staff" })
  staff!: StaffMember;

  @Column({ type: "text" })
  body!: string;

  @Column({ type: "integer", default: 1 })
  version!: number;

  @Column({ type: "varchar", length: 241, name: "updated_by_name" })
  updatedByName!: string;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt!: Date;
}
