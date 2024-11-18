import { Schema, model } from "mongoose";
import { IAIConfig } from "../../typings/AIconfig";

const schema = new Schema<IAIConfig>(
  {
    name: {
      type: String,
      lowercase: true,
    },
    recruiter: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    organization: {
      type: Schema.Types.ObjectId,
      ref: "organization",
    },
    prescreeningAssessment: {
      type: Boolean,
      default: true,
    },
    minPrescreeningScore: {
      type: Number,
    },
    cvSimilarity: {
      type: Boolean,
      default: true,
    },
    minCvSimilarityScore: {
      type: Number,
    },
    noOfCvSimilarCandidates: {
      type: Number,
    },
    personalizedAssessment: {
      type: Boolean,
      default: true,
    },
    noPersonalizedQuestions: {
      type: Number,
      default: 15,
    },
    recruiterGuide: {
      type: String,
    },
    uploadedQuestions: [
      {
        type: String,
      },
    ],
    personalityEvaluation: {
      type: Boolean,
      default: true,
    },
    stages: { type: Map, of: String },
  },
  { timestamps: true }
);

export default model<IAIConfig>("ai_config", schema);
