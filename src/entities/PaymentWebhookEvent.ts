import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("payment_webhook_events")
export class PaymentWebhookEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  @Index("UQ_payment_webhook_events_key", { unique: true })
  eventKey!: string;

  @Column({ type: "varchar" })
  event!: string;

  @Column({ type: "varchar", nullable: true, default: null })
  reference!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
