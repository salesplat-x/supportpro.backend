import Question from "../../models/v1/question";
import { Page, Paging } from "../../typings/customs";
import { IQuestion, QuestionType } from "../../typings/question";
import { HydratedDocument, Types } from "mongoose";
import * as func from "../../helpers/func";

export const createQuestion = async (
  question: IQuestion
): Promise<HydratedDocument<IQuestion>> => {
  return await new Question(question).save();
};

export const findQuestionById = async (id: Types.ObjectId | string) => {
  return await Question.findById(id).populate({
    path: "role",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
  });
};

export const createOrUpdatePersonalityEvaluation = async (
  job: string | Types.ObjectId,
  criteria: string,
  update: Partial<IQuestion>
) => {
  return await Question.findOneAndUpdate(
    { job, criteria },
    { ...update },
    {
      upsert: true,
      new: true,
    }
  );
};

export const findAllQuestions = async (paging: Paging = {}) => {
  return await Question.find()
    .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit)
    .populate({
      path: "role",
      select: "-__v -createdAt -updatedAt ",
      strictPopulate: false,
    });
};

export const findQuestionsByMatch = async (
  data: IQuestion | Record<string, any>,
  paging: Paging = {}
) => {
  return await Question.find(data)
    .select("question criteria _id")
    .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit);
  // .populate({
  //   path: "role",
  //   select: "-__v -createdAt -updatedAt ",
  //   strictPopulate: false,
  // });
};

export const findQuestionByIdAndUpdate = async (
  QuestionId: string | Types.ObjectId,
  data: Partial<IQuestion>
) => {
  return await Question.findByIdAndUpdate(QuestionId, data, {
    new: true,
  }).populate({
    path: "role",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
  });
};
