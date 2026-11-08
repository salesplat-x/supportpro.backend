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

  @Column({ type: "varchar", length: 32 })
  version!: string;

  @Column({ type: "timestamptz", name: "agreed_at" })
  agreedAt!: Date;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt!: Date;
}
