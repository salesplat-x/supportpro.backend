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
    recruiter: {
      type: Schema.Types.ObjectId,
      ref: "user",
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
    rank: Number,
    averageScore: Number,
    stages: { type: Map, of: String },
    assessmentRetryDate: Date,
  },
  { timestamps: true }
);

// Instance method to check if the candidate can retake the assessment
schema.methods.canTakeAssessment = function (): boolean {
  // If no assessmentRetryDate is set, the candidate can retake the assessment
  if (!this.assessmentRetryDate) {
    return true;
  }

  const currentDate = new Date();
  // Check if the current date is after the retry date
  return currentDate >= this.assessmentRetryDate;
};

// Instance method to set the assessmentRetryDate to one week from now
schema.methods.setAssessmentRetryDate = function (days = 7): void {
  const currentDate = new Date();
  this.assessmentRetryDate = new Date(
    currentDate.setDate(currentDate.getDate() + days)
  );
};

const Application = model<IApplication>("application", schema);
export default Application;
