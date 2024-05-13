import * as questionRepository from "../../repository/v1/question";
import * as roleRepository from "../../repository/v1/role";
import * as userRepository from "../../repository/v1/user";
import * as answerRepository from "../../repository/v1/answer";
import { makeResponse } from "../../helpers/response";
import {
  AnswerQuestionPayload,
  IQuestion,
  IQuestionConstruct,
} from "../../typings/question";
import mongoose from "mongoose";
import { IProfile, IUser } from "../../typings/user";
import { Paging } from "../../typings/customs";
import OpenAI from "openai";
import env from "../../config/env";
import { gradeAnswers } from "../../servces/v1/openai";

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
  // @TODO add the roleID and get all the
  let questionsConstruct: IQuestionConstruct[] = [];

  // Use transaction to ensure atomicity when storing answers
  const session = await answerRepository.startSession();
  session.startTransaction();

  if (payload.answers.length > 15) {
    return makeResponse(false, "Maximum length of answers 15 has been exceeded");
  }

  // Loop through the answers and map to the question
  for (const answer of payload.answers) {
    if (!mongoose.Types.ObjectId.isValid(answer.questionId as string)) {
      await session.abortTransaction();
      return makeResponse(false, "Invalid question id", {}, 400);
    }

    const question = await questionRepository.findQuestionById(
      answer.questionId
    );
    if (!question) {
      await session.abortTransaction();
      return makeResponse(false, "Question does not exist", {}, 404);
    }

    // save answer to DB
    await answerRepository.createAnswer(
      {
        question: answer.questionId,
        user: user._id,
        answer: answer.answer,
      },
      session
    );

    // Push questionObject into construct
    questionsConstruct.push({
      question: question.question,
      answer: answer.answer,
      criteria: question.criteria,
    });
  }

  await session.commitTransaction();

  const questionsJSON = JSON.stringify(questionsConstruct);

  const response = await gradeAnswers(questionsJSON);
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }
  const responseJSON: number[] = JSON.parse(response.message.content);

  if (responseJSON.length != questionsConstruct.length) {
    return makeResponse(
      false,
      "Length of response array doesn't match length of input array"
    );
  }

  let totalScore = 0;
  for (const score of responseJSON) {
    if (score > 5) {
      return makeResponse(false, "Score exceeds the maximum assignable score");
    }
    totalScore += score;
  }
  const maxScore = 5 * 15;
  const scorePercent = (totalScore / maxScore) * 100;

  await userRepository.updateUserScore(
    (user.profile as IProfile)._id,
    scorePercent
  );
  return makeResponse(true, "Answers submitted successfully");
};
