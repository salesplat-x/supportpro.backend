import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
  Check,
} from "typeorm";
import type { Organization } from "./Organization.js";
import type { StaffMember } from "./StaffMember.js";
import type { User } from "./User.js";

export enum DocumentTemplate {
  OfferLetter = "offer_letter",
  Nda = "nda",
  WorkOwnership = "work_ownership",
  PayAgreement = "pay_agreement",
}

export enum DocumentStatus {
  Draft = "draft",
  Sent = "sent",
  Signed = "signed",
  Declined = "declined",
}

export interface DocumentFields {
  startDate?: string;
  jobTitle?: string;
  managerName?: string;
}

@Entity("staff_documents")
@Check("CHK_staff_documents_signed", `("status" = 'signed') = ("signed_at" IS NOT NULL)`)
@Index("UQ_staff_documents_token_hash", ["tokenHash"], { unique: true })
@Index("UQ_staff_documents_staff_template_sent", ["staffId", "template"], {
  unique: true,
  where: `"status" = 'sent'`,
})
@Index("IDX_staff_documents_staff", ["staffId", "sentAt"])
@Index("IDX_staff_documents_signed_file_hash", ["signedFileHash"], {
  where: `"signed_file_hash" IS NOT NULL`,
})
@Index("IDX_staff_documents_finalize_due", ["finalizeNextRetryAt"], {
  where: `"finalized_at" IS NULL AND "finalize_next_retry_at" IS NOT NULL`,
})
export class StaffDocument {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "organization_id" })
  organizationId!: string;

  @ManyToOne("Organization", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_staff_documents_org" })
  organization!: Organization;

  @Column({ type: "uuid", name: "staff_id" })
  staffId!: string;

  @ManyToOne("StaffMember", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "staff_id", foreignKeyConstraintName: "FK_staff_documents_staff" })
  staff!: StaffMember;

  @Column({ type: "varchar", length: 32 })
  template!: DocumentTemplate;

  @Column({ type: "varchar", length: 120 })
  title!: string;

  @Column({ type: "text", name: "body_text" })
  bodyText!: string;

  @Column({ type: "varchar", length: 16, default: DocumentStatus.Sent })
  status!: DocumentStatus;

  @Column({ type: "jsonb", nullable: true })
  fields!: DocumentFields | null;

  @Column({ type: "timestamp", name: "declined_at", nullable: true })
  declinedAt!: Date | null;

  @Column({ type: "varchar", length: 64, name: "token_hash", nullable: true })
  tokenHash!: string | null;

  @Column({ type: "timestamp", name: "token_expires_at", nullable: true })
  tokenExpiresAt!: Date | null;

  @Column({ type: "uuid", name: "sent_by_id", nullable: true })
  sentById!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "sent_by_id", foreignKeyConstraintName: "FK_staff_documents_sent_by" })
  sentBy!: User | null;

  @Column({ type: "timestamp", name: "sent_at", nullable: true })
  sentAt!: Date | null;

  @Column({ type: "timestamp", name: "opened_at", nullable: true })
  openedAt!: Date | null;

  @Column({ type: "timestamp", name: "signed_at", nullable: true })
  signedAt!: Date | null;

  @Column({ type: "varchar", length: 120, name: "signer_name", nullable: true })
  signerName!: string | null;

  @Column({ type: "varchar", length: 64, name: "signer_ip", nullable: true })
  signerIp!: string | null;

  @Column({ type: "varchar", length: 64, name: "check_code", nullable: true })
  checkCode!: string | null;

  @Column({ type: "smallint", name: "check_code_version", default: 1 })
  checkCodeVersion!: number;

  @Column({ type: "varchar", length: 32, name: "check_stamp", nullable: true })
  checkStamp!: string | null;

  @Column({ type: "varchar", length: 300, name: "signed_file_key", nullable: true })
  signedFileKey!: string | null;

  @Column({ type: "varchar", length: 64, name: "signed_file_hash", nullable: true })
  signedFileHash!: string | null;

  @Column({ type: "timestamptz", name: "employee_copy_sent_at", nullable: true })
  employeeCopySentAt!: Date | null;

  @Column({ type: "timestamptz", name: "company_copy_sent_at", nullable: true })
  companyCopySentAt!: Date | null;

  @Column({ type: "timestamptz", name: "finalized_at", nullable: true })
  finalizedAt!: Date | null;

  @Column({ type: "integer", name: "finalize_attempts", default: 0 })
  finalizeAttempts!: number;

  @Column({ type: "timestamptz", name: "finalize_next_retry_at", nullable: true })
  finalizeNextRetryAt!: Date | null;

  @Column({ type: "timestamptz", name: "finalize_locked_at", nullable: true })
  finalizeLockedAt!: Date | null;

  @Column({ type: "text", name: "finalize_error", nullable: true })
  finalizeError!: string | null;

  @Column({ type: "boolean", name: "needs_notarization", default: false })
  needsNotarization!: boolean;

  @Column({ type: "varchar", length: 300, name: "notarized_scan_key", nullable: true })
  notarizedScanKey!: string | null;

  @Column({ type: "varchar", length: 64, name: "notarized_scan_type", nullable: true })
  notarizedScanType!: string | null;

  @Column({ type: "timestamp", name: "notarized_at", nullable: true })
  notarizedAt!: Date | null;

  @Column({ type: "varchar", length: 200, name: "notarized_scan_name", nullable: true })
  notarizedScanName!: string | null;

  @Column({ type: "varchar", length: 120, name: "notarized_by_name", nullable: true })
  notarizedByName!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
