import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from "typeorm";
import type { User } from "./User.js";

/** The admin's provider and model for one AI job. No row means the catalogue default. */
@Entity("ai_feature_settings")
export class AiFeatureSetting {
  @PrimaryColumn({ type: "varchar", length: 64, name: "feature_key" })
  featureKey!: string;

  @Column({ type: "varchar", length: 32 })
  provider!: string;

  @Column({ type: "varchar", length: 128 })
  model!: string;

  @Column({ type: "uuid", name: "updated_by_id", nullable: true })
  updatedById!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "updated_by_id", foreignKeyConstraintName: "FK_ai_feature_settings_updated_by" })
  updatedBy!: User | null;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
