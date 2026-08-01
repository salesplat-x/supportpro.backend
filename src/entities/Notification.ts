import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from "typeorm";
import type { User } from "./User.js";

@Entity("notifications")
@Index(["userId"])
@Index(["userId", "deleted", "createdAt"])
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

  @Column({ default: false })
  isRead!: boolean;

  @Column({ default: false })
  deleted!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
