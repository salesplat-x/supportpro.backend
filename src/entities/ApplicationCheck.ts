import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { CheckStatus, CheckType } from "../types/checks.js";
import type { Application } from "./Application.js";
import type { User } from "./User.js";

@Entity("application_checks")
@Index("IDX_application_checks_application", ["applicationId"])
export class ApplicationCheck {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "application_id" })
  applicationId!: string;

  @ManyToOne("Application", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "application_id" })
  application!: Application;

  @Column({ type: "uuid", name: "ordered_by_id" })
  orderedById!: string;

  @ManyToOne("User", { onDelete: "CASCADE", eager: false })
  @JoinColumn({ name: "ordered_by_id" })
  orderedBy!: User;

  @Column({ type: "varchar", length: 16 })
  type!: CheckType;

  @Column({ type: "varchar", length: 16, default: "pending" })
  status!: CheckStatus;

  @Column({ type: "text", name: "result_text", nullable: true, default: null })
  resultText!: string | null;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt!: Date;
}
