import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from "typeorm";
import type { User } from "./User.js";

/** The admin's wording for one shared AI skill. No row means the default in aiSkills.yaml. */
@Entity("ai_skill_settings")
export class AiSkillSetting {
  @PrimaryColumn({ type: "varchar", length: 64, name: "skill_key" })
  skillKey!: string;

  @Column({ type: "text" })
  text!: string;

  @Column({ type: "uuid", name: "updated_by_id", nullable: true })
  updatedById!: string | null;

  @ManyToOne("User", { eager: false, onDelete: "SET NULL", nullable: true })
  @JoinColumn({
    name: "updated_by_id",
    foreignKeyConstraintName: "FK_ai_skill_settings_updated_by",
  })
  updatedBy!: User | null;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
