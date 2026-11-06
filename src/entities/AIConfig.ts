import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import type { User } from "./User.js";
import type { Organization } from "./Organization.js";

@Entity("ai_configs")
export class AIConfig {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", nullable: true, default: null })
  name!: string | null;

  @Column({ type: "uuid", name: "recruiter_id" })
  recruiterId!: string;

  @ManyToOne("User", { eager: false })
  @JoinColumn({ name: "recruiter_id" })
  recruiter!: User;

  @Column({ type: "uuid", nullable: true, default: null, name: "organization_id" })
  organizationId!: string | null;

  @ManyToOne("Organization", { nullable: true, eager: false })
  @JoinColumn({ name: "organization_id" })
  organization!: Organization | null;

  @Column({ default: true })
  prescreeningAssessment!: boolean;

  @Column({ type: "float", nullable: true, default: null })
  minPrescreeningScore!: number | null;

  @Column({ default: true })
  cvSimilarity!: boolean;

  @Column({ type: "float", nullable: true, default: null })
  minCvSimilarityScore!: number | null;

  @Column({ default: true })
  personalizedAssessment!: boolean;

  @Column({ default: 15 })
  noPersonalizedQuestions!: number;

  @Column({ type: "text", nullable: true, default: null })
  recruiterGuide!: string | null;

  @Column({ type: "simple-array", nullable: true, default: null })
  uploadedQuestions!: string[] | null;

  @Column({ default: true })
  personalityEvaluation!: boolean;

  @Column({ type: "int", nullable: true, default: null })
  noOfEIQuestions!: number | null;

  @Column({ type: "int", nullable: true, default: null })
  noOfSNQuestions!: number | null;

  @Column({ type: "int", nullable: true, default: null })
  noOfTFQuestions!: number | null;

  @Column({ type: "int", nullable: true, default: null })
  noOfJPQuestions!: number | null;

  @Column({ default: false })
  problemSolvingAssessment!: boolean;

  @Column({ type: "int", nullable: true, default: null })
  noOfProblemSolvingQuestions!: number | null;

  @Column({ default: false })
  cultureFitAssessment!: boolean;

  @Column({ type: "int", nullable: true, default: null })
  noOfCultureFitQuestions!: number | null;

  @Column({ type: "jsonb", nullable: true, default: null })
  stages!: Record<string, string> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
