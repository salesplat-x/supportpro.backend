import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { User } from "./User.js";
import type { Organization } from "./Organization.js";

/** One row per change anyone in a company makes. Rows are never edited or deleted. */
@Entity("company_activities")
@Index("IDX_company_activities_org_created", ["organizationId", "createdAt"])
@Index("IDX_company_activities_org_actor_created", ["organizationId", "actorId", "createdAt"])
export class CompanyActivity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({
    name: "organization_id",
    foreignKeyConstraintName: "FK_company_activities_org",
  })
  organization!: Organization;

  @Column({ type: "uuid", name: "actor_id", nullable: true })
  actorId!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "actor_id", foreignKeyConstraintName: "FK_company_activities_actor" })
  actor!: User | null;

  @Column({ type: "varchar", length: 241, name: "actor_name" })
  actorName!: string;

  @Column({ type: "varchar", length: 120 })
  action!: string;

  @Column({ type: "varchar", length: 8 })
  method!: string;

  @Column({ type: "varchar", length: 255 })
  route!: string;

  @Column({ type: "varchar", length: 40, name: "target_type", nullable: true })
  targetType!: string | null;

  @Column({ type: "varchar", length: 64, name: "target_id", nullable: true })
  targetId!: string | null;

  @Column({ type: "varchar", length: 241, name: "target_label", nullable: true })
  targetLabel!: string | null;

  @Column({ type: "jsonb", name: "changed_fields", default: "[]" })
  changedFields!: string[];

  @Column({ type: "varchar", length: 64, nullable: true })
  ip!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
