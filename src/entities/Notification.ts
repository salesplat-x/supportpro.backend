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
import type { User } from "./User.js";

@Entity("notifications")
@Index(["userId"])
@Index(["userId", "deleted", "createdAt"])
@Index("UQ_notifications_user_dedupe", ["userId", "dedupeKey"], {
  unique: true,
  where: '"dedupe_key" IS NOT NULL',
})
export class Notification {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "varchar", nullable: true })
  title!: string | null;

  @Column({ type: "text" })
  message!: string;

  @Column({ type: "varchar", length: 32, nullable: true })
  type!: string | null;

  /** Set only by the server. A client can never choose where a notification sends someone. */
  @Column({ type: "varchar", length: 512, nullable: true })
  link!: string | null;

  /** The company the link belongs to, because opening it needs that company to be active. */
  @Column({ type: "uuid", name: "organization_id", nullable: true })
  organizationId!: string | null;

  @ManyToOne("Organization", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "organization_id", foreignKeyConstraintName: "FK_notifications_organization" })
  organization!: Organization | null;

  /** Stops the same event notifying someone twice. */
  @Column({ type: "varchar", length: 128, name: "dedupe_key", nullable: true })
  dedupeKey!: string | null;

  @Column({ default: false })
  isRead!: boolean;

  @Column({ default: false })
  deleted!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
