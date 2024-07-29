import { Schema, model } from "mongoose";
import {
  ApplicationStatus,
  ApplicationType,
  IApplication,
  ScreeningStage,
} from "../../typings/application";

const schema = new Schema<IApplication>(
  {
    job: {
      type: Schema.Types.ObjectId,
      ref: "job",
      required: true,
    },
    talent: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    role: {
      type: Schema.Types.ObjectId,
      ref: "role",
    },
    applicationType: {
      type: String,
      enum: Object.values(ApplicationType),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(ApplicationStatus),
      default: ApplicationStatus.Pending,
    },
    currentStage: {
      type: String,
      enum: Object.values(ScreeningStage),
      default: ScreeningStage.Prescreening,
    },
    personalizedQuestions: {
      type: [String],
    },
    personalizedScore: {
      type: Number,
    },
    cvSimilarityScore: {
      type: Number,
    },
    mbtiType: {
      type: String,
    },
  },
  { timestamps: true }
);

export default model<IApplication>("application", schema);
