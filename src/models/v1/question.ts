import { Schema, model } from "mongoose";
import { IQuestion } from "../../typings/question";

const questionSchema = new Schema<IQuestion>({
  role: {
    type: Schema.Types.ObjectId,
    ref: "role",
    required: true,
  },
  question: {
    type: String,
    required: true,
  },
  category: {
    type: String,
    required: true,
  },
  criteria: {
    type: String,
    required: true,
  },
});

export default model<IQuestion>("question", questionSchema);
