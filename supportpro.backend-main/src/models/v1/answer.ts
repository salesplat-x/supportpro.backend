import { Schema, model } from "mongoose";
import { IAnswer, IResponse } from "../../typings/answer";
import { QuestionType } from "../../typings/question";

const gradeSchema = new Schema<IResponse>(
  {
    question: {
      type: Schema.Types.ObjectId,
      ref: "question",
      required: true,
    },
    answer: {
      type: String,
      required: true,
    },
    score: {
      type: Number,
    },
    dichotomyPreference: {
      type: String,
    },
  },
  { _id: false }
);

const answerSchema = new Schema<IAnswer>(
  {
    role: {
      type: Schema.Types.ObjectId,
      ref: "role",
    },
    job: {
      type: Schema.Types.ObjectId,
      ref: "job",
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    questionType: {
      type: String,
      enum: Object.values(QuestionType),
      required: true,
    },
    responses: [gradeSchema],
  },
  { timestamps: true }
);

export default model<IAnswer>("answer", answerSchema);
