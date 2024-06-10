import * as questionRepository from "../../repository/v1/question";
import * as roleRepository from "../../repository/v1/role";
import * as userRepository from "../../repository/v1/user";
import * as answerRepository from "../../repository/v1/answer";
import * as jobRepository from "../../repository/v1/job";
import * as jobTalentRepository from "../../repository/v1/jobTalent";
import { makeResponse } from "../../helpers/response";
import {
  AnswerPersonalityPayload,
  AnswerQuestionPayload,
  IGeneratePersonalityQuestions,
  IGeneratePersonalizedQuestions,
  IQuestion,
  IQuestionConstruct,
  QuestionType,
} from "../../typings/question";
import mongoose from "mongoose";
import { IProfile, IUser } from "../../typings/user";
import { Paging } from "../../typings/customs";
import * as AI from "../../servces/v1/openai";
import { IRole } from "../../typings/role";
import { IResponse } from "../../typings/answer";
import { getJob, getTalents } from "../../repository/v1/pg";

// Function to create/add question for role
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

// Function to fetch all questions
export const fetchQuestions = async (payload: any) => {
  const query: mongoose.RootQuerySelector<IQuestion> = {};
  if (payload.jobId) {
    const job = await jobRepository.findJobById(payload.jobId);
    if (!job) {
      return makeResponse(false, "Job not found", {}, 404);
    }
    query.job = payload.jobId;
  }

  if (payload.roleId) {
    const role = await roleRepository.findRoleById(payload.roleId);
    if (!role) {
      return makeResponse(false, "Role not found", {}, 404);
    }
    query.role = payload.roleId;
  }
  if (payload.questionType) {
    query.type = payload.questionType;
  }

  const paging: Paging = {};
  if (payload.limit) {
    paging.limit = payload.limit;
  }
  if (payload.offset) {
    paging.offset = payload.offset;
  }
  if (payload.sort) {
    paging.sort = payload.sort;
  }

  const questions = await questionRepository.findQuestionsByMatch(query, paging);
  return makeResponse(true, "Questions fetched successfully", questions, 200);
};

// Function to fetch a question
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

// Function to answer questions
export const answerQuestions = async (
  user: IUser,
  payload: AnswerQuestionPayload
) => {
  if ((user.profile as IProfile).assessmentScore) {
    return makeResponse(false, "User has already taken assessment");
  }

  if (payload.answers.length > 15) {
    return makeResponse(false, "Maximum length of answers 15 has been exceeded");
  }

  // Get all question by Id
  const questionIds = payload.answers.map((answer) => answer.questionId);
  const questions = await questionRepository.findQuestionsByMatch({
    role: payload.roleId,
    _id: { $in: questionIds },
  });

  if (
    payload.roleId !=
    ((user.profile as IProfile).role[0]! as IRole)._id.toString()
  ) {
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

  const questionsJSON = JSON.stringify(questionsConstruct);

  // Use LLM to grade scores
  const response = await AI.gradeAnswers(questionsJSON);
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }

  const responseArray: IResponse[] = JSON.parse(
    response.message.content
  ).responses;

  if (responseArray.length != questionsConstruct.length) {
    return makeResponse(
      false,
      "Length of response array doesn't match length of input array"
    );
  }

  let totalScore = 0;
  for (const response of responseArray) {
    if (response.score > 5) {
      return makeResponse(false, "Score exceeds the maximum assignable score");
    }
    totalScore += response.score;
  }
  const maxScore = 5 * 15;
  const scorePercent = Number(((totalScore / maxScore) * 100).toFixed(2));

  await answerRepository.saveOrUpdateAnswer(
    user._id,
    payload.roleId,
    responseArray
  );

  await userRepository.updateUserScore(
    (user.profile as IProfile)._id,
    scorePercent
  );
  return makeResponse(true, "Answers submitted successfully", { scorePercent });
};

// Function to generate personalized questions
export const personalizedQuestions = async (
  payload: IGeneratePersonalizedQuestions
) => {
  const { jobId, talentId } = payload;
  const job = await getJob(jobId);
  if (!job) {
    return makeResponse(false, "Job not found", {}, 404);
  }

  const talent = await getTalents(talentId);
  if (talent.length == 0) {
    return makeResponse(false, "Talent not found", {}, 404);
  }
  const cv = talent.map((t) => t.cv_text);
  const recruiterGuide = payload.recruiterGuide?.length
    ? payload.recruiterGuide
    : [
        "Make sure to check the talent's CV and ask questions to test the validity of the claims",
      ];

  const response = await AI.generatePersonalizedQuestions(
    job.job_description,
    cv,
    recruiterGuide
  );
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }
  const questions = JSON.parse(response.message.content).questions;
  await jobTalentRepository.createOrUpdateJobTalent(jobId, talentId, {
    personalizedQuestions: questions,
  });

  return makeResponse(
    true,
    "Question generated successfully",
    { questions },
    200
  );
};

// Function to get personalized questions for a talent based on job
export const fetchPersonalizedQuestions = async (user: IUser, jobId: string) => {
  const questions = await jobTalentRepository.findJobTalentsByMatch({
    job: jobId,
    talent: user._id,
  });

  return makeResponse(
    true,
    "Personality questions fetched successfully",
    { questions },
    200
  );
};

// Function to generate personalized questions
export const personalityQuestion = async (
  payload: IGeneratePersonalityQuestions
) => {
  const job = await getJob(payload.jobId);
  if (!job) {
    return makeResponse(false, "Job not found", {}, 404);
  }

  const response = await AI.generatePersonalityQuestion(
    job.job_description,
    payload.dichotomyPair
  );
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }
  const question = JSON.parse(response.message.content).question;

  // Save question to job
  const pQuestion = await questionRepository.createOrUpdatePersonalityQuestion(
    payload.jobId,
    payload.dichotomyPair,
    { question, type: QuestionType.Personality }
  );

  return makeResponse(true, "Question created successfully", {
    question: pQuestion,
  });
};

// Function to answer personality questions
export const answerPersonalityQuestions = async (
  user: IUser,
  payload: AnswerPersonalityPayload
) => {
  if (payload.answers.length != 4) {
    return makeResponse(false, "You must answer exactly 4 questions");
  }

  // Get all question by Id
  const questionIds = payload.answers.map((answer) => answer.questionId);
  const questions = await questionRepository.findQuestionsByMatch({
    job: payload.jobId,
    type: QuestionType.Personality,
    _id: { $in: questionIds },
  });

  if (questions.length !== payload.answers.length) {
    return makeResponse(false, "One of more questions do not belong to job");
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
          dichotomy: question.criteria,
        });
      }
      return questionConstruct;
    },
    []
  );

  const questionsJSON = JSON.stringify(questionsConstruct);

  // Use LLM to determine MBTI personality type
  const response = await AI.determinePersonalityType(questionsJSON);
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }
  const personalityType = JSON.parse(response.message.content).personality;

  await userRepository.findProfileByIdAndUpdate((user.profile as IProfile)._id, {
    personalityType,
  });
  return makeResponse(true, "Personality assessment completed", {
    personalityType,
  });
};
