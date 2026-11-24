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
import type { User } from "./User.js";
import type { Organization } from "./Organization.js";
import type { Application } from "./Application.js";
import type { Department } from "./Department.js";

export enum StaffStatus {
  Invited = "invited",
  Active = "active",
  Ended = "ended",
}

export enum EndReason {
  Resigned = "resigned",
  Dismissed = "dismissed",
  ContractEnded = "contract_ended",
  Redundancy = "redundancy",
  Retired = "retired",
  MutualAgreement = "mutual_agreement",
  Other = "other",
}

@Entity("staff_members")
@Check(
  "CHK_staff_members_end_date_matches_status",
  `("status" = 'ended') = ("end_date" IS NOT NULL)`
)
@Check(
  "CHK_staff_members_ended_has_no_invite",
  `"status" <> 'ended' OR "invite_token_hash" IS NULL`
)
@Index("UQ_staff_members_org_email_open", ["organizationId", "email"], {
  unique: true,
  where: `"end_date" IS NULL`,
})
@Index("UQ_staff_members_org_user_open", ["organizationId", "userId"], {
  unique: true,
  where: `"end_date" IS NULL`,
})
@Index("UQ_staff_members_invite_token_hash", ["inviteTokenHash"], { unique: true })
@Index("UQ_staff_members_source_application", ["sourceApplicationId"], { unique: true })
@Index("IDX_staff_members_org_status", ["organizationId", "status"])
@Index("IDX_staff_members_manager", ["managerId"])
@Index("IDX_staff_members_department", ["departmentId"])
export class StaffMember {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_staff_members_org" })
  organization!: Organization;

  @Column({ type: "uuid", name: "user_id", nullable: true })
  userId!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "user_id", foreignKeyConstraintName: "FK_staff_members_user" })
  user!: User | null;

  @Column({ type: "varchar", length: 120, name: "full_name" })
  fullName!: string;

  @Column({ type: "varchar", length: 254 })
  email!: string;

  @Column({ type: "varchar", length: 120, name: "job_title" })
  jobTitle!: string;

  /** Display name, always written together with `departmentId`, which is what access uses. */
  @Column({ type: "varchar", length: 120, nullable: true })
  department!: string | null;

  @Column({ type: "uuid", name: "department_id", nullable: true })
  departmentId!: string | null;

  @ManyToOne("Department", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "department_id", foreignKeyConstraintName: "FK_staff_members_department" })
  departmentRef!: Department | null;

  @Column({ type: "uuid", name: "manager_id", nullable: true })
  managerId!: string | null;

  @ManyToOne("StaffMember", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "manager_id", foreignKeyConstraintName: "FK_staff_members_manager" })
  manager!: StaffMember | null;

  @Column({ type: "date", name: "start_date" })
  startDate!: string;

  @Column({ type: "date", name: "end_date", nullable: true })
  endDate!: string | null;

  @Column({ type: "varchar", length: 16, default: StaffStatus.Active })
  status!: StaffStatus;

  /** A last working day still ahead; the person stays active until the day has passed. */
  @Column({ type: "date", name: "ending_on", nullable: true })
  endingOn!: string | null;

  @Column({ type: "varchar", length: 32, name: "end_reason", nullable: true })
  endReason!: EndReason | null;

  @Column({ type: "boolean", name: "hired_through_auxhr", default: false })
  hiredThroughAuxhr!: boolean;

  /** The shortlisted application this person was hired from; one application gives at most one staff record. */
  @Column({ type: "uuid", name: "source_application_id", nullable: true })
  sourceApplicationId!: string | null;

  @ManyToOne("Application", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({
    name: "source_application_id",
    foreignKeyConstraintName: "FK_staff_members_source_application",
  })
  sourceApplication!: Application | null;

  @Column({ type: "boolean", name: "is_executive", default: false })
  isExecutive!: boolean;

  @Column({ type: "varchar", length: 40, nullable: true })
  phone!: string | null;

  @Column({ type: "varchar", length: 300, name: "home_address", nullable: true })
  homeAddress!: string | null;

  @Column({ type: "uuid", name: "invited_by_id", nullable: true })
  invitedById!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "invited_by_id", foreignKeyConstraintName: "FK_staff_members_invited_by" })
  invitedBy!: User | null;

  @Column({ type: "varchar", length: 241, name: "invited_by_name", nullable: true })
  invitedByName!: string | null;

  @Column({ type: "timestamp", name: "invited_at", nullable: true })
  invitedAt!: Date | null;

  @Column({ type: "varchar", length: 64, name: "invite_token_hash", nullable: true })
  inviteTokenHash!: string | null;

  @Column({ type: "timestamp", name: "invite_expires_at", nullable: true })
  inviteExpiresAt!: Date | null;

  @Column({ type: "timestamp", name: "invite_opened_at", nullable: true })
  inviteOpenedAt!: Date | null;

  @Column({ type: "timestamp", name: "joined_at", nullable: true })
  joinedAt!: Date | null;

  @Column({ type: "uuid", name: "created_by_id", nullable: true })
  createdById!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "created_by_id", foreignKeyConstraintName: "FK_staff_members_created_by" })
  createdBy!: User | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
