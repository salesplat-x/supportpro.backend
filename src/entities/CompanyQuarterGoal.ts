import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
} from "typeorm";
import type { Organization } from "./Organization.js";
import { numericColumn } from "./PayPackage.js";

@Entity("company_quarter_goals")
@Check("CHK_company_quarter_goals_goal", `"revenue_goal" > 0`)
@Check("CHK_company_quarter_goals_so_far", `"revenue_so_far" >= 0`)
@Index("UQ_company_quarter_goals_org_quarter", ["organizationId", "quarter"], { unique: true })
export class CompanyQuarterGoal {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_company_quarter_goals_org" })
  organization!: Organization;

  @Column({ type: "varchar", length: 7 })
  quarter!: string;

  @Column({ type: "varchar", length: 3 })
  currency!: string;

  @Column({
    type: "numeric",
    precision: 16,
    scale: 2,
    name: "revenue_goal",
    transformer: numericColumn,
  })
  revenueGoal!: number;

  @Column({
    type: "numeric",
    precision: 16,
    scale: 2,
    name: "revenue_so_far",
    default: 0,
    transformer: numericColumn,
  })
  revenueSoFar!: number;

  @Column({ type: "integer", default: 1 })
  version!: number;

  @Column({ type: "varchar", length: 241, name: "updated_by_name" })
  updatedByName!: string;

  @Column({ type: "timestamptz", name: "updated_at" })
  updatedAt!: Date;
}
