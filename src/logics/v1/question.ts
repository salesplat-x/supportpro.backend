import * as questionRepository from "../../repository/v1/question";
import * as roleRepository from "../../repository/v1/role";
import * as userRepository from "../../repository/v1/user";
import * as answerRepository from "../../repository/v1/answer";
import { makeResponse } from "../../helpers/response";
import { AnswerQuestionPayload, IQuestion } from "../../typings/question";
import mongoose from "mongoose";
import { IUser } from "../../typings/user";
import { Paging } from "../../typings/customs";

export const createQuestion = async (payload: IQuestion) => {
  if (!mongoose.Types.ObjectId.isValid(payload.role as string)) {
    return makeResponse(false, "Invalid role id", {}, 400);
  }
  const existingRole = await roleRepository.findRoleById(payload.role as string);
  if (!existingRole) {
    return makeResponse(false, "Role does not exist", {}, 404);
  }
  let question = await questionRepository.createQuestion(payload);
  return makeResponse(true, "Question posted successfully", question, 200);
};

export const fetchAllQuestions = async (payload: Paging) => {
  let questions = await questionRepository.findAllQuestions(payload);
  return makeResponse(true, "Questions fetched successfully", questions, 200);
};

export const fetchQuestion = async (payload: Pick<IQuestion, "_id">) => {
  if (!mongoose.Types.ObjectId.isValid(payload._id!)) {
    return makeResponse(false, "Invalid question id", {}, 400);
  }
  let question = await questionRepository.findQuestionById(payload._id!);
  if (!question) {
    return makeResponse(false, "Question not found", {}, 404);
  }
  return makeResponse(true, "Question fetched successfully", question, 200);
};

export const answerQuestions = async (
  user: IUser,
  payload: AnswerQuestionPayload
) => {
  let score: number;
  for (const answer of payload.answers) {
    if (!mongoose.Types.ObjectId.isValid(answer.questionId as string)) {
      return makeResponse(false, "Invalid question id", {}, 400);
    }

    const existingQuestion = await questionRepository.findQuestionById(
      answer.questionId
    );
    if (!existingQuestion) {
      return makeResponse(false, "Question does not exist", {}, 404);
    }

    // @TODO use LLM to evaluate answers and update score
    await answerRepository.createAnswer({
      question: answer.questionId,
      user: user._id,
      answer: answer.answer,
      // @TODO add weight and score
    });
  }

  // @TODO assign score to user's profile role
  // const score = ;
  // await userRepository.updateUserScore(
  //   (user.profile as IProfile)._id,
  //   score
  // );
  return makeResponse(true, "Answers submitted successfully");
};
