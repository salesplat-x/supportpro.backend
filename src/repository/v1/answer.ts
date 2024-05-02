import Answer from "../../models/v1/answer";
import { IAnswer } from "../../typings/answer";
import { HydratedDocument, Types } from "mongoose";

export const createAnswer = async (
  answer: Omit<IAnswer, "_id">
): Promise<HydratedDocument<IAnswer>> => {
  return await new Answer(answer).save();
};

export const findAnswerById = async (id: Types.ObjectId | string) => {
  return await Answer.findById(id).populate({
    path: "question user",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
  });
};
