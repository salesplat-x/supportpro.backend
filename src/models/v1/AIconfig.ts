import { Schema, model } from "mongoose";
import { IAIConfig } from "../../typings/AIconfig";

const schema = new Schema<IAIConfig>(
  {
    recruiter: {
      type: Schema.Types.ObjectId,
      ref: "user",
    },
    organization: {
      type: Schema.Types.ObjectId,
      ref: "organization",
    },
    recruiterGuide: {
      type: [String],
    },
    prescreeningAssessment: {
      type: Boolean,
      default: true,
    },
    cvSimilarity: {
      type: Boolean,
      default: true,
    },
    personalizedAssessment: {
      type: Boolean,
      default: true,
    },
    personalityEvaluation: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

export default model<IAIConfig>("ai_config", schema);
