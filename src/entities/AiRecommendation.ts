import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import { MatchVerdict, MatchRecommendation } from "../types/enums.js";

/**
 * Persisted AI Match recommendation for an application.
 * Generated once when the screening pipeline completes; only recomputed when
 * a recruiter explicitly regenerates. Viewing the AI Match panel / applicant
 * table reads this stored row — it never calls OpenAI again.
 */
@Entity("ai_recommendations")
export class AiRecommendation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "application_id", unique: true })
  @Index()
  applicationId!: string;

  @Column({ type: "enum", enum: MatchVerdict })
  verdict!: MatchVerdict;

  @Column({ type: "text" })
  reasoning!: string;

  @Column({ type: "enum", enum: MatchRecommendation, nullable: true, default: null })
  recommendation!: MatchRecommendation | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  strengths!: string[] | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  weaknesses!: string[] | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  risks!: string[] | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
