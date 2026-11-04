import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from "typeorm";
import type { User } from "./User.js";

/**
 * What the admin changed for one AI job. The models and default prompts themselves live in
 * the catalogue files, so a null provider or a missing prompt part means the catalogue default.
 */
@Entity("ai_feature_settings")
export class AiFeatureSetting {
  @PrimaryColumn({ type: "varchar", length: 64, name: "feature_key" })
  featureKey!: string;

  @Column({ type: "varchar", length: 32, nullable: true })
  provider!: string | null;

  @Column({ type: "varchar", length: 128, nullable: true })
  model!: string | null;

  @Column({ type: "jsonb", default: () => "'{}'" })
  prompts!: Record<string, string>;

  @Column({ type: "uuid", name: "updated_by_id", nullable: true })
  updatedById!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "updated_by_id", foreignKeyConstraintName: "FK_ai_feature_settings_updated_by" })
  updatedBy!: User | null;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
