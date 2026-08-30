import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { MatchVerdict, MatchRecommendation } from "../types/enums.js";
import type { Application } from "./Application.js";
import type { MatchAnalysis } from "../utils/matchAnalysis.js";

/**
 * Persisted AI Match recommendation for an application.
 * Generated once when the screening pipeline completes; only recomputed when
 * a recruiter explicitly regenerates. Viewing the AI Match panel / applicant
 * table reads this stored row — it never calls OpenAI again.
 *
 * Enum columns intentionally reuse the applications_* enum types created for
 * Application.matchVerdict / matchRecommendation (see CreateAiRecommendations
 * migration) so TypeORM schema sync does not invent parallel enum types.
 */
@Entity("ai_recommendations")
export class AiRecommendation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", name: "application_id", unique: true })
  @Index("IDX_ai_recommendations_application_id")
  applicationId!: string;

  @ManyToOne("Application", { onDelete: "CASCADE", eager: false })
  @JoinColumn({
    name: "application_id",
    foreignKeyConstraintName: "FK_ai_recommendations_application",
  })
  application!: Application;

  @Column({
    type: "enum",
    enum: MatchVerdict,
    enumName: "applications_matchverdict_enum",
  })
  verdict!: MatchVerdict;

  @Column({ type: "text" })
  reasoning!: string;

  @Column({
    type: "enum",
    enum: MatchRecommendation,
    enumName: "applications_matchrecommendation_enum",
    nullable: true,
    default: null,
  })
  recommendation!: MatchRecommendation | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  strengths!: string[] | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  weaknesses!: string[] | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  risks!: string[] | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  analysis!: MatchAnalysis | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
