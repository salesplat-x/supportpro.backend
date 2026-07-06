import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from "typeorm";
import type { User } from "./User.js";

/**
 * Stores CV text chunks and their embeddings for a talent user.
 * One user can have multiple rows (one per CV text chunk).
 * Merges Mongoose CvEmbedding model with the pgvector talents table.
 */
@Entity("talent_embeddings")
@Index(["userId"])
export class TalentEmbedding {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "user_id" })
  userId!: string;

  @ManyToOne("User", { eager: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "varchar", nullable: true, default: null, name: "cv_public_id" })
  cvPublicId!: string | null;

  @Column({ type: "text", nullable: true, default: null, name: "cv_text" })
  cvText!: string | null;

  // pgvector embedding stored as text in pgvector format: [0.1,0.2,...]
  @Column({ type: "text", nullable: true, default: null, name: "cv_embedding", select: false })
  cvEmbedding!: string | null;

  @Column({ type: "timestamp", name: "generated_at" })
  generatedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
