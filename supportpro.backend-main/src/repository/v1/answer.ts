import Answer from "../../models/v1/answer";
import { IAnswer, IResponse } from "../../typings/answer";
import { FilterQuery, HydratedDocument, Types } from "mongoose";

export const startSession = async () => {
  return await Answer.startSession();
};

export const insertMany = async (answers: Omit<IAnswer, "_id">[]) => {
  return await Answer.insertMany(answers);
};

export const createAnswer = async (
  answer: Omit<IAnswer, "_id">
): Promise<HydratedDocument<IAnswer>> => {
  return await new Answer(answer).save();
};

export const saveOrUpdateAnswer = async (
  filter: FilterQuery<IAnswer>,
  responses: IResponse[]
) => {
  return await Answer.findOneAndUpdate(
    filter,
    { responses },
    {
      upsert: true,
    }
  );
};

export const findAnswerById = async (id: Types.ObjectId | string) => {
  return await Answer.findById(id).populate({
    path: "question user",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
  });
};
