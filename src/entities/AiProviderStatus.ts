import { Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

/**
 * Whether a provider last refused a call for billing, and its balance where the provider has an
 * API for it. credit_error holds only the status and error code: provider messages can quote
 * part of the key.
 */
@Entity("ai_provider_status")
export class AiProviderStatus {
  @PrimaryColumn({ type: "varchar", length: 32 })
  provider!: string;

  @Column({ type: "timestamptz", name: "out_of_credit_since", nullable: true, default: null })
  outOfCreditSince!: Date | null;

  @Column({ type: "varchar", length: 64, name: "credit_error", nullable: true, default: null })
  creditError!: string | null;

  @Column({ type: "numeric", precision: 16, scale: 4, nullable: true, default: null })
  balance!: string | null;

  @Column({ type: "varchar", length: 16, name: "balance_unit", nullable: true, default: null })
  balanceUnit!: string | null;

  @Column({ type: "timestamptz", name: "balance_checked_at", nullable: true, default: null })
  balanceCheckedAt!: Date | null;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
