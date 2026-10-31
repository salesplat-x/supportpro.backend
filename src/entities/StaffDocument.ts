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
  Sent = "sent",
  Signed = "signed",
}

@Entity("staff_documents")
@Check("CHK_staff_documents_signed", `("status" = 'signed') = ("signed_at" IS NOT NULL)`)
@Index("UQ_staff_documents_token_hash", ["tokenHash"], { unique: true })
@Index("UQ_staff_documents_staff_template_sent", ["staffId", "template"], {
  unique: true,
  where: `"status" = 'sent'`,
})
@Index("IDX_staff_documents_staff", ["staffId", "sentAt"])
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

  @Column({ type: "varchar", length: 64, name: "token_hash", nullable: true })
  tokenHash!: string | null;

  @Column({ type: "timestamp", name: "token_expires_at", nullable: true })
  tokenExpiresAt!: Date | null;

  @Column({ type: "uuid", name: "sent_by_id", nullable: true })
  sentById!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "sent_by_id", foreignKeyConstraintName: "FK_staff_documents_sent_by" })
  sentBy!: User | null;

  @Column({ type: "timestamp", name: "sent_at" })
  sentAt!: Date;

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

  @Column({ type: "boolean", name: "needs_notarization", default: false })
  needsNotarization!: boolean;

  @Column({ type: "varchar", length: 300, name: "notarized_scan_key", nullable: true })
  notarizedScanKey!: string | null;

  @Column({ type: "varchar", length: 64, name: "notarized_scan_type", nullable: true })
  notarizedScanType!: string | null;

  @Column({ type: "timestamp", name: "notarized_at", nullable: true })
  notarizedAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
