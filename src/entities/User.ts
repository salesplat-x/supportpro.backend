import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  ManyToMany,
  JoinTable,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import { UserRole, Currency, CompensationPeriod } from "../types/enums.js";
import type { Organization } from "./Organization.js";
import type { Role } from "./Role.js";
import type { PreScreening } from "./PreScreening.js";

@Entity("users")
@Index("idx_users_talent_score", ["userRole", "prescreeningScore"], {
  where: `"userRole" = 'talent'`,
})
@Index("idx_users_single_admin", ["userRole"], {
  unique: true,
  where: `"userRole" = 'admin'`,
})
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", unique: true })
  @Index()
  email!: string;

  @Column({ type: "varchar", select: false })
  password!: string;

  @Column({ type: "varchar" })
  firstName!: string;

  @Column({ type: "varchar" })
  lastName!: string;

  @Column({ type: "varchar", nullable: true, default: null })
  middleName!: string | null;

  @Column({ type: "enum", enum: UserRole, default: UserRole.Talent })
  userRole!: UserRole;

  @Column({ type: "varchar", nullable: true, default: null })
  phone!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  country!: string | null;

  @Column({ type: "uuid", nullable: true, default: null, name: "organization_id" })
  organizationId!: string | null;

  @ManyToOne("Organization", { nullable: true, eager: false })
  @JoinColumn({ name: "organization_id" })
  organization!: Organization | null;

  @Column({ type: "boolean", default: true })
  emailVerified!: boolean;

  @Column({ type: "boolean", default: true })
  active!: boolean;

  @Column({ type: "varchar", nullable: true, default: null, select: false })
  recoveryCode!: string | null;

  @Column({ type: "timestamp", nullable: true, default: null, select: false })
  recoveryCodeExpiry!: Date | null;

  @Column({ type: "int", default: 0 })
  tokenVersion!: number;

  // ---- Profile fields (merged from Profile model) ----

  @Column({ type: "text", nullable: true, default: null })
  bio!: string | null;

  /** Original uploaded file name (e.g. jane-doe-cv.pdf). */
  @Column({ type: "varchar", nullable: true, default: null })
  cvFileName!: string | null;

  /** Full extracted CV text used for AI and on-demand PDF regeneration. */
  @Column({ type: "text", nullable: true, default: null, select: false })
  cvText!: string | null;

  @Column({ type: "timestamp", nullable: true, default: null })
  cvUploadedAt!: Date | null;

  @Column({ type: "simple-array", nullable: true, default: null })
  workType!: string[] | null;

  @Column({ type: "varchar", nullable: true, default: null })
  locationCity!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  locationState!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  locationCountry!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  experience!: string | null;

  @Column({ type: "enum", enum: Currency, nullable: true, default: Currency.NGN })
  currency!: Currency | null;

  @Column({ type: "float", nullable: true, default: null })
  maxSalary!: number | null;

  @Column({ type: "float", nullable: true, default: null })
  minSalary!: number | null;

  @Column({
    type: "enum",
    enum: CompensationPeriod,
    nullable: true,
    default: CompensationPeriod.Yearly,
  })
  compensationPeriod!: CompensationPeriod | null;

  @Column({ type: "float", nullable: true, default: null })
  prescreeningScore!: number | null;

  @Column({ type: "timestamp", nullable: true, default: null })
  assessmentRetryDate!: Date | null;

  @Column({ type: "int", default: 0 })
  roleChangeCount!: number;

  @Column({ type: "uuid", nullable: true, default: null, name: "active_prescreening_id" })
  activePreScreeningId!: string | null;

  @ManyToOne("PreScreening", { nullable: true, eager: false })
  @JoinColumn({ name: "active_prescreening_id" })
  activePreScreening!: PreScreening | null;

  @ManyToMany("Role", { eager: false })
  @JoinTable({
    name: "user_roles",
    joinColumn: { name: "user_id", referencedColumnName: "id" },
    inverseJoinColumn: { name: "role_id", referencedColumnName: "id" },
  })
  userRoles!: Role[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
