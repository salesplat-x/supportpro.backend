import Answer from "../../models/v1/answer";
import { IAnswer } from "../../typings/answer";
import { HydratedDocument, Types, ClientSession } from "mongoose";

export const startSession = async () => {
  return await Answer.startSession();
};

export const createAnswer = async (
  answer: Omit<IAnswer, "_id">,
  session?: ClientSession
): Promise<HydratedDocument<IAnswer>> => {
  return await new Answer(answer).save({ session });
};

export const findAnswerById = async (id: Types.ObjectId | string) => {
  return await Answer.findById(id).populate({
    path: "question user",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
  });
};
