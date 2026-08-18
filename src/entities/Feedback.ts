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

@Entity("feedback")
@Index(["userId", "createdAt"])
@Index(["isRead"])
export class Feedback {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "varchar", nullable: true, default: null })
  subject!: string | null;

  @Column({ type: "text" })
  message!: string;

  @Column({ default: false })
  isRead!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
