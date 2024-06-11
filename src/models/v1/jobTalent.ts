import { Schema, model } from "mongoose";
import { IJobTalent } from "../../typings/jobTalent";

const schema = new Schema<IJobTalent>(
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

export default model<IJobTalent>("job_talent", schema);
