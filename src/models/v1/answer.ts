import { Schema, model } from "mongoose";
import { IAnswer, IResponse } from "../../typings/answer";

const gradeSchema = new Schema<IResponse>({
  question: {
    type: String,
    required: true,
  },
  answer: {
    type: String,
    required: true,
  },
  score: {
    type: Number,
    required: true,
  },
});

const answerSchema = new Schema<IAnswer>(
  {
    role: {
      type: Schema.Types.ObjectId,
      ref: "role",
      required: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    responses: [gradeSchema],
  },
  { timestamps: true }
);

export default model<IAnswer>("answer", answerSchema);
