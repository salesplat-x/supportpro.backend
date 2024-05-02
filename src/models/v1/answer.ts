import { Schema, model } from "mongoose";
import { IAnswer } from "../../typings/answer";

const answerSchema = new Schema<IAnswer>({
  question: {
    type: Schema.Types.ObjectId,
    ref: "question",
    required: true,
  },
  user: {
    type: Schema.Types.ObjectId,
    ref: "user",
    required: true,
  },
  answer: {
    type: String,
    required: true,
  },
  score: {
    type: Number,
  },
  weight: {
    type: Number,
  },
});

export default model<IAnswer>("answer", answerSchema);
