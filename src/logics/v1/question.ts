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
import { gradeAnswers } from "../../servces/v1/openai";
import { IRole } from "../../typings/role";

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
  if ((user.profile as IProfile).score) {
    return makeResponse(false, "User has already taken assessment");
  }

  if (payload.answers.length > 15) {
    return makeResponse(false, "Maximum length of answers 15 has been exceeded");
  }

  // Get all question by Id
  const questionIds = payload.answers.map((answer) => answer.questionId);
  const questions = await questionRepository.findQuestionByMatch({
    role: payload.roleId,
    _id: { $in: questionIds },
  });

  if (payload.roleId !== ((user.profile as IProfile).role[0]! as IRole)._id) {
    return makeResponse(
      false,
      "User is not permitted to take assessment for this role"
    );
  }

  if (questions.length !== payload.answers.length) {
    return makeResponse(false, "One of more questions do not belong to role");
  }

  // Map questions by ID for efficient lookup
  const questionMap = new Map(
    questions.map((q) => [
      q._id.toString(),
      {
        question: q.question,
        criteria: q.criteria,
      },
    ])
  );

  // Validate answers and prepare valid answers for grading
  const questionsConstruct = payload.answers.reduce(
    (questionConstruct: IQuestionConstruct[], ans) => {
      const question = questionMap.get(ans.questionId as string);
      if (question) {
        questionConstruct.push({
          questionId: ans.questionId,
          question: question.question,
          answer: ans.answer,
          criteria: question.criteria,
        });
      }
      return questionConstruct;
    },
    []
  );

  await answerRepository.insertMany(
    questionsConstruct.map((ans) => ({
      question: ans.questionId,
      answer: ans.answer,
      user: user._id,
    }))
  );

  const questionsJSON = JSON.stringify(questionsConstruct);

  // Use LLM to grade scores
  const response = await gradeAnswers(questionsJSON);
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }
  const scores = JSON.parse(response.message.content).scores;
  if (scores.length != questionsConstruct.length) {
    return makeResponse(
      false,
      "Length of response array doesn't match length of input array"
    );
  }

  let totalScore = 0;
  for (const score of scores) {
    if (score > 5) {
      return makeResponse(false, "Score exceeds the maximum assignable score");
    }
    totalScore += score;
  }
  const maxScore = 5 * 15;
  const scorePercent = Number(((totalScore / maxScore) * 100).toFixed(2));

  await userRepository.updateUserScore(
    (user.profile as IProfile)._id,
    scorePercent
  );
  return makeResponse(true, "Answers submitted successfully");
};
