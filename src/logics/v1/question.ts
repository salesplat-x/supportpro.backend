import * as questionRepository from "../../repository/v1/question";
import * as roleRepository from "../../repository/v1/role";
import { makeResponse } from "../../helpers/response";
import { IQuestion } from "../../typings/question";

export const createQuestion = async (payload: IQuestion) => {
  const existingRole = await roleRepository.findRoleById(payload.role as string);
  if (!existingRole) {
    return makeResponse(false, "Role does not exist", {}, 404);
  }
  let question = await questionRepository.createQuestion(payload);
  return makeResponse(true, "Question posted successfully", question, 200);
};

export const fetchAllQuestions = async () => {
  let questions = await questionRepository.findAllQuestions();
  return makeResponse(true, "Questions fetched successfully", questions, 200);
};

export const fetchQuestion = async (payload: Pick<IQuestion, "_id">) => {
  let question = await questionRepository.findQuestionById(payload._id!);
  if (!question) {
    return makeResponse(false, "Question not found", {}, 404);
  }
  return makeResponse(true, "Question fetched successfully", question, 200);
};
