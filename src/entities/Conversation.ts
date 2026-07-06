import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToMany,
  ManyToOne,
  JoinTable,
  JoinColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import type { User } from "./User.js";
import type { Message } from "./Message.js";

@Entity("conversations")
export class Conversation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @ManyToMany("User", { eager: false })
  @JoinTable({
    name: "conversation_participants",
    joinColumn: { name: "conversation_id", referencedColumnName: "id" },
    inverseJoinColumn: { name: "user_id", referencedColumnName: "id" },
  })
  participants!: User[];

  @Column({ type: "uuid", nullable: true, default: null, name: "last_message_id" })
  lastMessageId!: string | null;

  @ManyToOne("Message", { nullable: true, eager: false })
  @JoinColumn({ name: "last_message_id" })
  lastMessage!: Message | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
