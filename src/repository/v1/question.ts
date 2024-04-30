import Question from "../../models/v1/question";
import { IQuestion } from "../../typings/question";
import { HydratedDocument, Types } from "mongoose";

export const createQuestion = async (
  question: IQuestion
): Promise<HydratedDocument<IQuestion>> => {
  return await new Question(question).save();
};

export const findQuestionById = async (id: Types.ObjectId | string) => {
  return await Question.findById(id).populate({
    path: "role",
    select: "-__v -createdAt -updatedAt -_id",
    strictPopulate: false,
  });
};

export const findAllQuestions = async () => {
  return await Question.find().populate({
    path: "role",
    select: "-__v -createdAt -updatedAt -_id",
    strictPopulate: false,
  });
};

export const findQuestionByMatch = async (
  data: IQuestion | Record<string, any>
) => {
  return await Question.find(data).populate({
    path: "role",
    select: "-__v -createdAt -updatedAt -_id",
    strictPopulate: false,
  });
};

export const findQuestionByIdAndUpdate = async (
  QuestionId: string | Types.ObjectId,
  data: Partial<IQuestion>
) => {
  return await Question.findByIdAndUpdate(QuestionId, data, {
    new: true,
  }).populate({
    path: "role",
    select: "-__v -createdAt -updatedAt -_id",
    strictPopulate: false,
  });
};
