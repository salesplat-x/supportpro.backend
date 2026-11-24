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

/**
 * A company's department. Names are unique per company in any letter case; that is enforced
 * by locking the company row while adding, because the index below only matches exact case.
 */
@Entity("departments")
@Index("UQ_departments_org_name", ["organizationId", "name"], { unique: true })
export class Department {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_departments_org" })
  organization!: Organization;

  @Column({ type: "varchar", length: 120 })
  name!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
