import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import { ErrorLogLevel } from "../types/enums.js";

@Entity("error_logs")
@Index(["timestamp", "level"])
@Index(["environment", "timestamp"])
@Index(["resolved", "timestamp"])
@Index(["errorType", "timestamp"])
export class ErrorLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  @Index()
  timestamp!: Date;

  @Column({ type: "enum", enum: ErrorLogLevel, default: ErrorLogLevel.Error })
  @Index()
  level!: ErrorLogLevel;

  @Column({ type: "text" })
  @Index()
  message!: string;

  @Column({ type: "text", nullable: true, default: null })
  stack!: string | null;

  @Column({ type: "varchar" })
  @Index()
  errorType!: string;

  @Column({ type: "varchar", nullable: true, default: null })
  @Index()
  userId!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  @Index()
  requestId!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  @Index()
  endpoint!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  @Index()
  method!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  userAgent!: string | null;

  @Column({ type: "varchar", nullable: true, default: null })
  @Index()
  ip!: string | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  requestBody!: Record<string, unknown> | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  requestQuery!: Record<string, unknown> | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  requestParams!: Record<string, unknown> | null;

  @Column({ type: "int", nullable: true, default: null })
  @Index()
  responseStatus!: number | null;

  @Column({ type: "varchar" })
  @Index()
  environment!: string;

  @Column({ type: "varchar", nullable: true, default: null })
  version!: string | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  metadata!: Record<string, unknown> | null;

  @Column({ default: false })
  @Index()
  resolved!: boolean;

  @Column({ type: "timestamp", nullable: true, default: null })
  resolvedAt!: Date | null;

  @Column({ type: "varchar", nullable: true, default: null })
  resolvedBy!: string | null;

  @Column({ type: "simple-array", nullable: true, default: null })
  tags!: string[] | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
