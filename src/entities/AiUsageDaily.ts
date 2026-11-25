import { Column, Entity, PrimaryColumn } from "typeorm";

/** How much each AI job used of each provider's model on one day (UTC). Rows only ever add up. */
@Entity("ai_usage_daily")
export class AiUsageDaily {
  @PrimaryColumn({ type: "date" })
  day!: string;

  @PrimaryColumn({ type: "varchar", length: 32 })
  provider!: string;

  @PrimaryColumn({ type: "varchar", length: 100 })
  model!: string;

  @PrimaryColumn({ type: "varchar", length: 64 })
  feature!: string;

  @Column({ type: "int", default: 0 })
  calls!: number;

  @Column({ type: "int", name: "failed_calls", default: 0 })
  failedCalls!: number;

  @Column({ type: "int", name: "credit_failures", default: 0 })
  creditFailures!: number;

  @Column({ type: "bigint", name: "input_tokens", default: 0 })
  inputTokens!: string;

  @Column({ type: "bigint", name: "output_tokens", default: 0 })
  outputTokens!: string;

  @Column({ type: "bigint", default: 0 })
  characters!: string;

  @Column({ type: "numeric", precision: 14, scale: 2, name: "audio_seconds", default: 0 })
  audioSeconds!: string;
}
