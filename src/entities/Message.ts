import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import type { Conversation } from "./Conversation.js";
import type { Application } from "./Application.js";
import type { User } from "./User.js";

@Entity("messages")
export class Message {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "conversation_id" })
  conversationId!: string;

  @ManyToOne("Conversation", { eager: false })
  @JoinColumn({ name: "conversation_id" })
  conversation!: Conversation;

  @Column({ type: "uuid", nullable: true, default: null, name: "application_id" })
  applicationId!: string | null;

  @ManyToOne("Application", { nullable: true, eager: false })
  @JoinColumn({ name: "application_id" })
  application!: Application | null;

  @Column({ type: "uuid", name: "sender_id" })
  senderId!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "sender_id" })
  sender!: User;

  @Column({ type: "uuid", name: "recipient_id" })
  recipientId!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "recipient_id" })
  recipient!: User;

  @Column({ type: "text" })
  content!: string;

  @Column({ type: "boolean", nullable: true, default: null })
  acknowledged!: boolean | null;

  @Column({ default: false })
  @Index()
  isRead!: boolean;

  @Column({ default: false })
  deleted!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
