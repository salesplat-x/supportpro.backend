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
import type { Organization } from "./Organization.js";
import { CvEmbeddingStatus } from "../types/enums.js";

/**
 * A person sourced from an uploaded CV — the platform-wide talent pool.
 *
 * Separate from `scouts` because a `scouts` row is per-campaign-per-run: the same
 * person uploaded to three campaigns is three `scouts` rows, while the pool needs
 * exactly one row per person (deduped on `emailNormalized`).
 *
 * Visible to every recruiter's Talent Search; `firstSourcedByOrganizationId` is
 * attribution only and does not restrict visibility.
 */
@Entity("scout_candidates")
export class ScoutCandidate {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Lowercased, trimmed email — the dedup key. Unique where not null. */
  @Column({ type: "varchar", nullable: true, default: null, name: "email_normalized" })
  @Index("IDX_scout_candidates_email", { unique: true, where: '"email_normalized" IS NOT NULL' })
  emailNormalized!: string | null;

  @Column({ type: "varchar", nullable: true, default: null, name: "full_name" })
  fullName!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  phone!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  headline!: string | null;

  @Column({ type: "varchar", nullable: true, default: null, name: "location_city" })
  locationCity!: string | null;

  @Column({ type: "varchar", nullable: true, default: null, name: "location_state" })
  locationState!: string | null;

  @Column({ type: "varchar", nullable: true, default: null, name: "location_country" })
  locationCountry!: string | null;

  @Column({ type: "text", nullable: true, default: null })
  summary!: string | null;

  @Column({ type: "simple-array", nullable: true, default: null })
  skills!: string[] | null;

  @Column({ type: "int", nullable: true, default: null, name: "years_experience" })
  yearsExperience!: number | null;

  /** Extracted CV text — the embedding source. Never sent to clients. */
  @Column({ type: "text", nullable: true, default: null, name: "cv_text", select: false })
  cvText!: string | null;

  @Column({ type: "varchar", nullable: true, default: null, name: "cv_file_url" })
  cvFileUrl!: string | null;

  /** Spaces object key — needed to serve the file through an authenticated route. */
  @Column({ type: "varchar", nullable: true, default: null, name: "cv_file_key" })
  cvFileKey!: string | null;

  // pgvector embedding stored as text in pgvector format: [0.1,0.2,...]
  @Column({ type: "text", nullable: true, default: null, select: false })
  embedding!: string | null;

  @Column({
    type: "enum",
    enum: CvEmbeddingStatus,
    nullable: true,
    default: null,
    name: "embedding_status",
  })
  embeddingStatus!: CvEmbeddingStatus | null;

  @Column({ type: "int", default: 0, name: "embedding_attempts" })
  embeddingAttempts!: number;

  @Column({
    type: "timestamp with time zone",
    nullable: true,
    default: null,
    name: "embedding_next_retry_at",
  })
  embeddingNextRetryAt!: Date | null;

  @Column({
    type: "timestamp with time zone",
    nullable: true,
    default: null,
    name: "embedding_locked_at",
  })
  embeddingLockedAt!: Date | null;

  @Column({ type: "text", nullable: true, default: null, name: "embedding_last_error" })
  embeddingLastError!: string | null;

  @Column({
    type: "uuid",
    nullable: true,
    default: null,
    name: "first_sourced_by_organization_id",
  })
  firstSourcedByOrganizationId!: string | null;

  @ManyToOne("Organization", { nullable: true, eager: false, onDelete: "SET NULL" })
  @JoinColumn({
    name: "first_sourced_by_organization_id",
    foreignKeyConstraintName: "FK_scout_candidates_organization",
  })
  firstSourcedByOrganization!: Organization | null;

  @Column({
    type: "timestamp with time zone",
    name: "last_seen_at",
    default: () => "CURRENT_TIMESTAMP",
  })
  lastSeenAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
