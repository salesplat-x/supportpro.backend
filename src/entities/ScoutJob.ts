import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Check,
} from "typeorm";
import type { Role } from "./Role.js";
import type { User } from "./User.js";
import type { Organization } from "./Organization.js";
import { ExperienceLevel, WorkMode } from "../types/enums.js";
import { DEFAULT_SHORTLIST_SIZE } from "../config/scout.js";

@Entity("scout_jobs")
@Check("CHK_scout_jobs_shortlist_size", `"shortlist_size" BETWEEN 2 AND 10`)
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

  /** How many best-fit candidates the AI shortlists from a run. DB-checked 2..10. */
  @Column({ type: "int", default: DEFAULT_SHORTLIST_SIZE, name: "shortlist_size" })
  shortlistSize!: number;

  @Column({
    type: "enum",
    enum: ExperienceLevel,
    nullable: true,
    default: null,
    name: "experience_level",
  })
  experienceLevel!: ExperienceLevel | null;

  /** Skills a candidate cannot do the job without — near-disqualifying when missing. */
  @Column({ type: "simple-array", nullable: true, default: null, name: "must_have_skills" })
  mustHaveSkills!: string[] | null;

  /** Bonus skills — used to break ties between otherwise similar candidates. */
  @Column({ type: "simple-array", nullable: true, default: null, name: "nice_to_have_skills" })
  niceToHaveSkills!: string[] | null;

  @Column({ type: "enum", enum: WorkMode, nullable: true, default: null, name: "work_mode" })
  workMode!: WorkMode | null;

  @Column({ type: "varchar", nullable: true, default: null, name: "location_country" })
  locationCountry!: string | null;

  @Column({ type: "varchar", nullable: true, default: null, name: "location_state" })
  locationState!: string | null;

  @Column({ type: "varchar", nullable: true, default: null, name: "location_city" })
  locationCity!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
