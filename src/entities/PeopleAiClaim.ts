import { Entity, PrimaryColumn, Column } from "typeorm";

/** Lets one AI call run at a time for the same work. A crashed server's claim simply expires. */
@Entity("people_ai_claims")
export class PeopleAiClaim {
  @PrimaryColumn({ type: "varchar", length: 120 })
  key!: string;

  @Column({ type: "uuid" })
  token!: string;

  @Column({ type: "timestamptz", name: "claimed_at" })
  claimedAt!: Date;
}
