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
import type { Role } from "./Role.js";
import type { User } from "./User.js";
import type { Organization } from "./Organization.js";

@Entity("scout_jobs")
export class ScoutJob {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "role_id" })
  roleId!: string;

  @ManyToOne("Role", { eager: false })
  @JoinColumn({ name: "role_id" })
  role!: Role;

  @Column({ type: "uuid", name: "posted_by_id" })
  postedById!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "posted_by_id" })
  postedBy!: User;

  @Column({ type: "uuid", nullable: true, default: null, name: "organization_id" })
  @Index("IDX_scout_jobs_organization_id")
  organizationId!: string | null;

  @ManyToOne("Organization", { nullable: true, eager: false })
  @JoinColumn({
    name: "organization_id",
    foreignKeyConstraintName: "FK_scout_jobs_organization",
  })
  organization!: Organization | null;

  @Column({ type: "text" })
  jobBrief!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "text" })
  recruiterGuide!: string;

  // pgvector embedding stored as text in pgvector format: [0.1,0.2,...]
  @Column({ type: "text", nullable: true, default: null, name: "job_embedding", select: false })
  jobEmbedding!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
