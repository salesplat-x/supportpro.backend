import { Schema, model } from "mongoose";
import { IPersonalityQuestion } from "../../typings/question";

const schema = new Schema<IPersonalityQuestion>(
  {
    job: {
      type: Schema.Types.ObjectId,
      ref: "job",
      required: true,
    },
    question: {
      type: String,
      required: true,
    },
    dichotomyPair: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

export default model<IPersonalityQuestion>("personality_questions", schema);
