import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import type { Application } from "./Application.js";
import type { User } from "./User.js";

@Entity("application_consents")
@Index("UQ_application_consents_application", ["applicationId"], { unique: true })
export class ApplicationConsent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "application_id" })
  applicationId!: string;

  @ManyToOne("Application", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "application_id" })
  application!: Application;

  @Column({ type: "uuid", name: "talent_id" })
  talentId!: string;

  @ManyToOne("User", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "talent_id" })
  talent!: User;

  @Column({ type: "varchar", length: 32, nullable: true, default: null })
  version!: string | null;

  @Column({ type: "timestamptz", name: "agreed_at", nullable: true, default: null })
  agreedAt!: Date | null;

  @Column({ type: "timestamptz", name: "requested_at", nullable: true, default: null })
  requestedAt!: Date | null;

  @Column({ type: "timestamptz", name: "declined_at", nullable: true, default: null })
  declinedAt!: Date | null;

  @Column({ type: "varchar", length: 3, name: "id_kind", nullable: true, default: null })
  idKind!: "nin" | "bvn" | null;

  @Column({ type: "text", name: "id_number_encrypted", nullable: true, default: null })
  idNumberEncrypted!: string | null;

  @Column({ type: "varchar", length: 4, name: "id_number_last4", nullable: true, default: null })
  idNumberLast4!: string | null;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
