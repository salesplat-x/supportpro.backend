import * as questionRepository from "../../repository/v1/question";
import * as roleRepository from "../../repository/v1/role";
import * as userRepository from "../../repository/v1/user";
import * as answerRepository from "../../repository/v1/answer";
import * as jobRepository from "../../repository/v1/job";
import * as pgRepository from "../../repository/v1/pg";
import * as applicationRepository from "../../repository/v1/application";
import { makeResponse } from "../../helpers/response";
import {
  EvaluatePersonalityPayload,
  AnswerPersonalizedPayload,
  AnswerPrescreeningPayload,
  IGeneratePersonalityQuestions,
  IGeneratePersonalizedQuestions,
  IQuestion,
  IQuestionConstruct,
  QuestionType,
  FetchQuestions,
} from "../../typings/question";
import mongoose from "mongoose";
import { IProfile, IUser } from "../../typings/user";
import { Paging } from "../../typings/customs";
import * as AI from "../../services/v1/openai";
import { IRole } from "../../typings/role";
import { IResponse } from "../../typings/answer";
import { ApplicationType } from "../../typings/application";

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
export const fetchQuestions = async (payload: FetchQuestions) => {
  const query: mongoose.RootQuerySelector<IQuestion> = {};
  let questions: IQuestion[];

  // @TODO select a number of questions randomly
  // const randomQuestions = await Question.aggregate([
  //   { $match: { role } },
  //   { $sample: { size: numberOfQuestions } } // Randomly sample the specified number of questions
  // ]);

  if (payload.questionType == QuestionType.Personalized) {
    if (!payload.talentId || !payload.jobId) {
      return makeResponse(
        false,
        "talentId and jobId required to fetch personalized questions"
      );
    }

    const application = await applicationRepository.findApplicationByMatch({
      job: payload.jobId,
      talent: payload.talentId,
    });
    if (!application) {
      return makeResponse(false, "Application record not found", {}, 404);
    }

    questions = await questionRepository.findQuestionsByMatch({
      _id: { $in: application?.personalizedQuestions },
    });
  } else {
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

    questions = await questionRepository.findQuestionsByMatch(query, paging);
  }
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

// Function to answer prescreening assessment questions
export const answerPrescreening = async (
  user: IUser,
  payload: AnswerPrescreeningPayload
) => {
  if ((user.profile as IProfile).prescreeningScore) {
    return makeResponse(false, "User has already taken assessment");
  }

  const questionIds = Object.keys(payload.answers);
  if (questionIds.length > 15) {
    return makeResponse(false, "Maximum length of answers 15 has been exceeded");
  }

  if (
    payload.roleId !=
    ((user.profile as IProfile).role[0]! as IRole)._id.toString()
  ) {
    return makeResponse(
      false,
      "User is not permitted to take assessment for this role"
    );
  }

  // Get all questions by Id
  const questions = await questionRepository.findQuestionsByMatch({
    role: payload.roleId,
    _id: { $in: questionIds },
  });

  if (questions.length !== questionIds.length) {
    return makeResponse(false, "One or more questions do not belong to role");
  }

  // Create the Assessment object for the Ai Model
  const questionsConstruct = questions.map((q): IQuestionConstruct => {
    return {
      question: q.question,
      questionId: q._id.toString()!,
      criteria: q.criteria,
      answer: payload.answers[q._id.toString()]!,
    };
  });

  const questionsJSON = JSON.stringify(questionsConstruct);

  // Use LLM to grade scores
  const response = await AI.gradeAssessmentAnswers(questionsJSON);
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
    if (response.score! > 5) {
      return makeResponse(false, "Score exceeds the maximum assignable score");
    }
    totalScore += response.score!;
  }
  const maxScore = 5 * responseArray.length;
  const scorePercent = Number(((totalScore / maxScore) * 100).toFixed(2));

  // Save answers to DB
  await answerRepository.saveOrUpdateAnswer(
    {
      user: user._id,
      role: payload.roleId,
      questionType: QuestionType.Prescreening,
    },
    responseArray
  );

  await userRepository.updateUserScore(
    (user.profile as IProfile)._id,
    scorePercent
  );
  return makeResponse(true, "Answers submitted successfully", { scorePercent });
};

// Function to generate personalized questions
export const generatePersonalizedQuestions = async (
  payload: IGeneratePersonalizedQuestions
) => {
  const { jobId, talentId } = payload;

  // Check if user already has personalized question
  const application = await applicationRepository.findApplicationByMatch({
    job: jobId,
    talent: talentId,
  });

  if (application) {
    if (application.personalizedQuestions?.length) {
      return makeResponse(
        false,
        "personalized questions already generated for this talent"
      );
    }
  }

  const job = await pgRepository.getJob(jobId);
  if (!job) {
    return makeResponse(false, "Job not found", {}, 404);
  }

  const talent = await pgRepository.getTalents(talentId);
  if (talent.length == 0) {
    return makeResponse(false, "Talent not found", {}, 404);
  }
  const cv = talent.map((t) => t.cv_text);

  const user = await userRepository.findUserById(talentId);
  const bio = (user?.profile as IProfile).bio;
  // @TODO get recruiter's guide from job in DB
  const recruiterGuide = payload.recruiterGuide?.length
    ? payload.recruiterGuide
    : [
        "Make sure to check the talent's CV and ask questions to test the validity of the claims",
      ];

  const response = await AI.generatePersonalizedQuestions(
    job.job_description,
    cv,
    bio,
    recruiterGuide
  );
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }
  const questions = JSON.parse(response.message.content).questions;

  // save questions in DB
  let questionIds: mongoose.Types.ObjectId[] = [];
  const questionObjects = questions.map((question: string): IQuestion => {
    const _id = new mongoose.Types.ObjectId();
    questionIds.push(_id);
    return { _id, type: QuestionType.Personalized, question, job: jobId };
  });

  await questionRepository.insertMany(questionObjects);
  await applicationRepository.createOrUpdateApplication(jobId, talentId, {
    personalizedQuestions: questionIds,
    $setOnInsert: { applicationType: ApplicationType.Invitation },
  });

  return makeResponse(
    true,
    "Personalized questions generated successfully",
    { questions },
    200
  );
};

// Function to answer personalized questions
export const answerPersonalizedQuestions = async (
  user: IUser,
  payload: AnswerPersonalizedPayload
) => {
  const { answers, jobId } = payload;

  const questionIds = Object.keys(answers);
  const questions = await questionRepository.findQuestionsByMatch({
    job: jobId,
    _id: { $in: questionIds },
  });
  // const scorePercent = questions;

  const questionConstruct = questions.map((q) => {
    return {
      question: q.question,
      questionId: q._id,
      answer: answers[q._id.toString()],
    };
  });

  const answersJSON = JSON.stringify(questionConstruct);

  // Use LLM to grade answers
  const response = await AI.gradePersonalizedAnswers(answersJSON);
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }

  const responseArray: IResponse[] = JSON.parse(
    response.message.content
  ).responses;

  if (responseArray.length != questionIds.length) {
    return makeResponse(
      false,
      "Length of response array doesn't match length of input array"
    );
  }

  let totalScore = 0;
  for (const response of responseArray) {
    if (response.score! > 5) {
      return makeResponse(false, "Score exceeds the maximum assignable score");
    }
    totalScore += response.score!;
  }

  const maxScore = 5 * responseArray.length;
  const scorePercent = Number(((totalScore / maxScore) * 100).toFixed(2));

  const application = await applicationRepository.findApplicationByIdAndUpdate(
    { job: jobId, talent: user._id },
    {
      personalizedScore: scorePercent,
    }
  );

  if (!application) {
    return makeResponse(false, "Job application not found", {}, 404);
  }

  await answerRepository.saveOrUpdateAnswer(
    { job: jobId, user: user._id, questionType: QuestionType.Personalized },
    responseArray
  );

  return makeResponse(
    true,
    "Answers graded successfully",
    { scorePercent },
    200
  );
};

// Function to generate personality evaluation question
export const generatePersonalityQuestion = async (
  payload: IGeneratePersonalityQuestions
) => {
  const job = await pgRepository.getJob(payload.jobId);
  if (!job) {
    return makeResponse(false, "Job not found", {}, 404);
  }

  const response = await AI.getPersonalityEvaluationQuestion(
    job.job_description,
    payload.dichotomyPair
  );
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }
  const question = JSON.parse(response.message.content).question;

  // Save question to job
  const pQuestion = await questionRepository.createOrUpdatePersonalityEvaluation(
    payload.jobId,
    payload.dichotomyPair,
    { question, type: QuestionType.Personality }
  );

  return makeResponse(true, "Question created successfully", {
    question: pQuestion,
  });
};

// Function to answer personality questions
export const evaluatePersonalityType = async (
  user: IUser,
  payload: EvaluatePersonalityPayload
) => {
  const { answers, jobId } = payload;
  const questionIds = Object.keys(answers);

  if (questionIds.length != 4) {
    return makeResponse(false, "You must answer exactly 4 questions");
  }

  // Get all question by Id
  const questions = await questionRepository.findQuestionsByMatch({
    job: jobId,
    type: QuestionType.Personality,
    _id: { $in: questionIds },
  });

  if (questions.length !== questionIds.length) {
    return makeResponse(false, "One of more questions do not belong to job");
  }

  const questionsConstruct = questions.map((q) => {
    return {
      question: q.question,
      questionId: q._id.toString(),
      answer: answers[q._id.toString()],
      dichotomy: q.criteria,
    };
  });

  const questionsJSON = JSON.stringify(questionsConstruct);

  // Use LLM to determine MBTI personality type
  const response = await AI.evaluatePersonalityType(questionsJSON);
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }

  // Save answers and personality
  const { mbtiType, responses } = JSON.parse(response.message.content);

  await answerRepository.saveOrUpdateAnswer(
    { user: user._id, job: jobId, questionType: QuestionType.Personality },
    responses
  );

  await applicationRepository.createOrUpdateApplication(jobId, user._id, {
    mbtiType,
    $setOnInsert: { applicationType: ApplicationType.Application },
  });
  return makeResponse(true, "Personality evaluation completed", {
    mbtiType,
  });
};
