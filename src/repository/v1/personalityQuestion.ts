import Question from "../../models/v1/personalityQuestion";
import { Page, Paging } from "../../typings/customs";
import { IPersonalityQuestion } from "../../typings/question";
import { HydratedDocument, Types } from "mongoose";
import * as func from "../../helpers/func";

export const createQuestion = async (
  question: IPersonalityQuestion
): Promise<HydratedDocument<IPersonalityQuestion>> => {
  return await new Question(question).save();
};

export const createOrUpdateQuestion = async (
  job: string | Types.ObjectId,
  dichotomyPair: string,
  question: string
) => {
  return await Question.findOneAndUpdate(
    { job, dichotomyPair },
    { question },
    {
      upsert: true,
      new: true,
    }
  );
};

export const findQuestionById = async (id: Types.ObjectId | string) => {
  return await Question.findById(id).populate({
    path: "job",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
  });
};

export const findAllQuestions = async (paging: Paging = {}) => {
  return await Question.find()
    .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit)
    .populate({
      path: "job",
      select: "-__v -createdAt -updatedAt ",
      strictPopulate: false,
    });
};

export const findQuestionByMatch = async (
  data: IPersonalityQuestion | Record<string, any>,
  paging: Paging = {}
) => {
  return await Question.find(data)
    .select("question criteria _id")
    .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit);
  // .populate({
  //   path: "job",
  //   select: "-__v -createdAt -updatedAt ",
  //   strictPopulate: false,
  // });
};

export const findQuestionByIdAndUpdate = async (
  QuestionId: string | Types.ObjectId,
  data: Partial<IPersonalityQuestion>
) => {
  return await Question.findByIdAndUpdate(QuestionId, data, {
    new: true,
  }).populate({
    path: "job",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
  });
};
