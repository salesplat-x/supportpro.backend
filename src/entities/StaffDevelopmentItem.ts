import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { Organization } from "./Organization.js";
import type { StaffMember } from "./StaffMember.js";

export enum DevelopmentStatus {
  Proposed = "proposed",
  Open = "open",
  Done = "done",
}

export enum DevelopmentSource {
  Manual = "manual",
  Ai = "ai",
  SkillTest = "skill_test",
}

@Entity("staff_development_items")
@Index("IDX_staff_development_items_staff", ["staffId", "status"])
@Index("UQ_staff_development_items_source", ["staffId", "source", "sourceRef"], {
  unique: true,
  where: `"source_ref" IS NOT NULL`,
})
export class StaffDevelopmentItem {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({
    name: "organization_id",
    foreignKeyConstraintName: "FK_staff_development_items_org",
  })
  organization!: Organization;

  @Column({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_development_items_staff" })
  staff!: StaffMember;

  @Column({ type: "varchar", length: 200, name: "weak_area" })
  weakArea!: string;

  @Column({ type: "varchar", length: 1000 })
  action!: string;

  @Column({ type: "date", name: "due_on", nullable: true })
  dueOn!: string | null;

  @Column({ type: "varchar", length: 16, default: DevelopmentStatus.Open })
  status!: DevelopmentStatus;

  @Column({ type: "varchar", length: 16, default: DevelopmentSource.Manual })
  source!: DevelopmentSource;

  /** Identifies the outside result behind an item, so importing it twice adds it once. */
  @Column({ type: "varchar", length: 200, name: "source_ref", nullable: true })
  sourceRef!: string | null;

  @Column({ type: "integer", default: 1 })
  version!: number;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
