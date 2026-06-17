import { Schema, model } from "mongoose";
import { IGeneratedQuestion, IPreScreening, TQuestionCategory } from "../../typings/prescreening";

const questionCategories: TQuestionCategory[] = [
  "professional_competency",
  "practical_problem_solving",
  "communication",
  "behavioral",
  "cultural",
  "leadership",
  "emotional_intelligence",
];

const generatedQuestionSchema = new Schema<IGeneratedQuestion>(
  {
    questionId: { type: String, required: true },
    question: { type: String, required: true },
    category: { type: String, enum: questionCategories, required: true },
    options: { type: [String], required: true },
    correctOption: { type: Number, required: true },
    intent: { type: String, required: true },
    scoringHint: { type: String, required: false },
  },
  { _id: false }
);

const preScreeningSchema = new Schema<IPreScreening>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    roles: {
      type: [String],
      required: true,
    },
    questions: {
      type: [generatedQuestionSchema],
      default: [],
    },
    score: {
      type: Number,
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "completed"],
      default: "pending",
    },
    attemptCount: {
      type: Number,
      default: 1,
      min: 1,
    },
    maxAttempts: {
      type: Number,
      default: 2,
    },
    generatedAt: {
      type: Date,
      required: true,
    },
    completedAt: {
      type: Date,
      required: false,
    },
    metadata: {
      type: Schema.Types.Mixed,
      required: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

preScreeningSchema.index({ userId: 1 });

export const PreScreening = model<IPreScreening>("prescreening", preScreeningSchema);
