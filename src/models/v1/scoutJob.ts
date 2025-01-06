import { Schema, model } from "mongoose";
import { IScoutJob } from "../../typings/scoutJob";

const schema = new Schema<IScoutJob>(
  {
    role: {
      type: Schema.Types.ObjectId,
      ref: "role",
      required: true,
    },
    postedBy: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    recruiterGuide: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

export default model<IScoutJob>("scout_job", schema);
