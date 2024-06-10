import { Schema, model } from "mongoose";
import { IJobTalent } from "../../typings/jobTalent";

const schema = new Schema<IJobTalent>(
  {
    job: {
      type: Schema.Types.ObjectId,
      ref: "job",
    },
    role: {
      type: Schema.Types.ObjectId,
      ref: "role",
    },
    talent: {
      type: Schema.Types.ObjectId,
      ref: "user",
    },
    personalizedQuestions: {
      type: [String],
    },
    mbtiType: {
      type: String,
    },
  },
  { timestamps: true }
);

export default model<IJobTalent>("job_talent", schema);
