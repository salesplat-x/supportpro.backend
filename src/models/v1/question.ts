import { Schema, model } from "mongoose";
import { IQuestion, QuestionType } from "../../typings/question";

const questionSchema = new Schema<IQuestion>(
  {
    role: {
      type: Schema.Types.ObjectId,
      ref: "role",
    },
    job: {
      type: Schema.Types.ObjectId,
      ref: "job",
    },
    type: {
      type: String,
      enum: Object.values(QuestionType),
      required: true,
    },
    question: {
      type: String,
      required: true,
    },
    criteria: {
      type: String,
      required: true,
    },
    category: {
      type: String,
    },
  },
  { timestamps: true }
);

export default model<IQuestion>("question", questionSchema);
