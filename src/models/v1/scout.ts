import { Schema, model } from "mongoose";
import { IScout } from "../../typings/scout";

const schema = new Schema<IScout>(
  {
    batchId: String,
    cvName: {
      type: String,
    },
    cvText: {
      type: String,
    },
    coverLetterName: {
      type: String,
    },
    coverLetterText: {
      type: String,
    },
    cvScore: Number,
    coverLetterScore: Number,
    evaluationScore: Number,

    recruiter: {
      type: Schema.Types.ObjectId,
      ref: "user",
    },
    scoutJob: {
      type: Schema.Types.ObjectId,
      ref: "user",
    },
  },
  { timestamps: true }
);

export default model<IScout>("scout", schema);
