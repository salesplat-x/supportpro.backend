import * as questionRepository from "../../repository/v1/question";
import * as roleRepository from "../../repository/v1/role";
import * as userRepository from "../../repository/v1/user";
import * as answerRepository from "../../repository/v1/answer";
import * as jobRepository from "../../repository/v1/job";
import * as pgRepository from "../../repository/v1/pg";
import * as applicationRepository from "../../repository/v1/application";
import { Document } from "mongoose";
import { IApplication } from "../../typings/application";
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
import {
  ApplicationStatus,
  ApplicationType,
  //IApplication,
  ScreeningStage,
} from "../../typings/application";
import { findAIconfigById } from "../../repository/v1/AIconfig";
import { calculateTimeLeft } from "../../helpers/func";
import { JobStatus } from "../../typings/job";

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
export const fetchQuestions = async (user: IUser, payload: FetchQuestions) => {
  const query: Partial<IQuestion> = { type: payload.questionType };
  const profile = user.profile as IProfile;
  let questions: IQuestion[];
  let application: IApplication | null;

  // Check if user wants to retake assessment and is allowed to

  if (!profile || !profile.role || !profile.role[0]) {
    return makeResponse(false, "User profile is incomplete!", {}, 400);
  }

  if (payload.jobId) {
    // Check if user can retake assessment for the job
    const job = await jobRepository.findJobById(payload.jobId);
    if (!job) {
      return makeResponse(false, "Job not found", {}, 404);
    }
    query.job = payload.jobId;
    application = await applicationRepository.findApplicationByMatch({
      job: payload.jobId,
      talent: user._id,
    });
    if (!application) {
      return makeResponse(false, "Application record not found", {}, 404);
    }
    if (!application.canTakeAssessment()) {
      const days = calculateTimeLeft(application.assessmentRetryDate!);
      return makeResponse(
        false,
        `Sorry, you cannot take this assessment at the moment, retry ${days}`,
        {},
        403
      );
    }
    if (payload.questionType == QuestionType.Personalized) {
      // For Personalized questions get the application and fetch the personalized questions
      questions = await questionRepository.findQuestionsByMatch({
        _id: { $in: application?.personalizedQuestions },
      });

      return makeResponse(
        true,
        "Questions fetched successfully",
        questions,
        200
      );
    }
  }
  if (payload.questionType === QuestionType.Prescreening) {
    if (!profile.canTakeAssessment()) {
      const days = calculateTimeLeft(profile.assessmentRetryDate!);
      return makeResponse(
        false,
        `Sorry, you cannot take this assessment at the moment, retry ${days}`,
        {},
        403
      );
    }

    // @TODO select a number of questions randomly
    // const randomQuestions = await Question.aggregate([
    //   { $match: { role } },
    //   { $sample: { size: numberOfQuestions } } // Randomly sample the specified number of questions
    // ]);
    // Check if input role is a role of user
    if ((profile.role[0] as IRole).id !== payload.roleId!) {
      return makeResponse(
        false,
        "User is not permitted to take assessment for this role",
        {},
        403
      );
    }
    delete query.type;
    query.role = payload.roleId;
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

  console.log(query);
  questions = await questionRepository.findQuestionsByMatch(query, paging);
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
  const profile = user.profile as IProfile;

  if (!profile || !profile.role || !profile.role[0]) {
    return makeResponse(false, "User profile is incomplete!", {}, 400);
  }

  if (!profile.canTakeAssessment()) {
    const days = calculateTimeLeft(profile.assessmentRetryDate!);
    return makeResponse(
      false,
      `Sorry, you cannot take this assessment at the moment, retry ${days}`,
      {},
      403
    );
  }

  if (payload.roleId !== (profile.role[0] as IRole).id) {
    return makeResponse(
      false,
      "User is not permitted to take assessment for this role",
      {},
      403
    );
  }

  const questionIds = Object.keys(payload.answers);
  const MAX_ANSWERS = 15;
  if (questionIds.length > MAX_ANSWERS) {
    return makeResponse(
      false,
      `Maximum length of answers ${MAX_ANSWERS} has been exceeded`,
      {},
      400
    );
  }

  // Get all questions by Id
  const questions = await questionRepository.findQuestionsByMatch({
    role: payload.roleId,
    _id: { $in: questionIds },
  });

  if (questions.length !== questionIds.length) {
    return makeResponse(
      false,
      "One or more questions do not belong to the role",
      {},
      400
    );
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
  if (!response || !response.message || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }

  const responseArray: IResponse[] = JSON.parse(
    response.message.content
  ).responses;

  if (responseArray.length !== questionsConstruct.length) {
    return makeResponse(
      false,
      "Length of response array doesn't match length of input array",
      {},
      400
    );
  }

  let totalScore = 0;
  for (const res of responseArray) {
    if (res.score == null || res.score > 5) {
      return makeResponse(false, "Invalid score received", {}, 400);
    }
    totalScore += res.score;
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

  profile.setAssessmentRetryDate();
  profile.prescreeningScore = scorePercent;
  await profile.save();

  return makeResponse(true, "Answers submitted successfully", {
    scorePercent,
  });
};

// Function to generate personalized questions
export const generatePersonalizedQuestions = async (
  payload: IGeneratePersonalizedQuestions
) => {
  const { jobId, talentId } = payload;

  const existingJob = await jobRepository.findJobById(jobId);
  if (!existingJob) {
    return makeResponse(false, "Job not found!", {}, 404);
  }
  if (existingJob.status === JobStatus.Closed) {
    return makeResponse(
      false,
      `Applications for this job is currently ${existingJob.status}!`
    );
  }

  const aiConfig = await findAIconfigById(existingJob.aiConfig as string);
  if (!aiConfig) {
    return makeResponse(false, "AI configuration for job not found!", {}, 404);
  }

  if (!aiConfig.personalizedAssessment) {
    return makeResponse(
      false,
      "This feature was not configured for this job!",
      {},
      400
    );
  }

  // Check if user already has personalized question
  let application = await applicationRepository.findApplicationByMatch({
    job: jobId,
    talent: talentId,
  });

  if (application) {
    if (application.personalizedQuestions?.length) {
      const questions = await questionRepository.findQuestionsByMatch({
        _id: { $in: application.personalizedQuestions },
      });
      return makeResponse(true, "Personalized questions already created", {
        questions: questions,
        application,
      });
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

  const response = await AI.generatePersonalizedQuestions(
    job.job_description,
    cv,
    bio,
    aiConfig.noPersonalizedQuestions,
    aiConfig.recruiterGuide
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
  const applicationRes = await applicationRepository.createOrUpdateApplication(
    jobId,
    talentId,
    {
      personalizedQuestions: questionIds,
      $setOnInsert: {
        recruiter: aiConfig.recruiter,
        applicationType: ApplicationType.Application,
        stages: aiConfig.stages,
      },
    }
  );

  // Increase number of applications if new application created
  if (!applicationRes.lastErrorObject?.updatedExisting) {
    await jobRepository.findJobByIdAndUpdate(jobId, {
      $inc: { noOfApplicants: 1 },
    });
  }

  return makeResponse(
    true,
    "Personalized questions generated successfully",
    { application: applicationRes.value, questions: questionObjects },
    200
  );
};

// Function to answer personalized questions
export const answerPersonalizedQuestions = async (
  user: IUser,
  payload: AnswerPersonalizedPayload
) => {
  const { answers, jobId } = payload;

  // Validate input
  if (!answers || Object.keys(answers).length === 0) {
    return makeResponse(false, "No answers provided", {}, 400);
  }

  // Fetch job details
  const job = await jobRepository.findJobById(jobId);
  if (!job) {
    return makeResponse(false, "Job not found!", {}, 404);
  }
  if (job.status === JobStatus.Closed) {
    return makeResponse(
      false,
      `Applications for this job is currently ${job.status}!`
    );
  }

  // Fetch application details
  //let application = await applicationRepository.findApplicationByMatch({
  //  job: jobId,
  //  talent: user._id,
  //});

  let application: (IApplication & Document) | null =
      await applicationRepository.findApplicationByMatch(
        { talent: user._id, job: jobId }
      );

  if (!application) {
    return makeResponse(false, "Job application not found", {}, 404);
  }

  if (!application.canTakeAssessment()) {
    const days = calculateTimeLeft(application.assessmentRetryDate!);
    return makeResponse(
      false,
      `Sorry, you cannot take this assessment at the moment, retry ${days}`,
      {},
      403
    );
  }

  // Fetch AI configuration
  const aiConfig = await findAIconfigById(job.aiConfig as string);
  if (!aiConfig) {
    return makeResponse(false, "AI configuration for job not found!", {}, 404);
  }

  // Check if personalized assessment is configured
  if (!aiConfig.personalizedAssessment) {
    return makeResponse(
      false,
      "This feature was not configured for this job!",
      {},
      400
    );
  }

  // Find the questions in the DB using their ids
  const questionIds = Object.keys(answers);
  const questions = await questionRepository.findQuestionsByMatch({
    job: jobId,
    _id: { $in: questionIds },
  });

  const questionConstruct = questions.map((q) => {
    return {
      question: q.question,
      questionId: q._id,
      answer: answers[q._id.toString()],
    };
  });

  const answersJSON = JSON.stringify(questionConstruct);

  // Use LLM to grade answers
  const response = await AI.gradePersonalizedAnswers(
    answersJSON,
    aiConfig.recruiterGuide
  );
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }

  const responseArray: IResponse[] = JSON.parse(
    response.message.content
  ).responses;

  if (responseArray.length !== questionIds.length) {
    return makeResponse(
      false,
      "Length of response array doesn't match length of input array",
      {},
      400
    );
  }

  const MAX_SCORE = 5;
  let totalScore = 0;
  for (const response of responseArray) {
    if (response.score! > MAX_SCORE) {
      return makeResponse(
        false,
        "Score exceeds the maximum assignable score",
        {},
        400
      );
    }
    totalScore += response.score!;
  }

  const maxScore = MAX_SCORE * responseArray.length;
  const scorePercent = Number(((totalScore / maxScore) * 100).toFixed(2));

  application.personalizedScore = scorePercent;
  // Update application status based on score
  if (scorePercent < aiConfig.minPrescreeningScore) {
    application.currentStage = ScreeningStage.Personalized;
    application.status = ApplicationStatus.RetakeAssessment;
    application.setAssessmentRetryDate();
  } else {
    application = await applicationRepository.processNextStage(
      user,
      application,
      ScreeningStage.Personalized
    );
  }

  await application.save();

  // Save answers to DB
  await answerRepository.saveOrUpdateAnswer(
    { job: jobId, user: user._id, questionType: QuestionType.Personalized },
    responseArray
  );

  return makeResponse(
    true,
    "Answers graded successfully",
    { scorePercent, application },
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

  // Save or replace question for job
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
  const job = await jobRepository.findJobById(jobId);
  if (!job) {
    return makeResponse(false, "Job not found!", {}, 404);
  }
  if (job.status === JobStatus.Closed) {
    return makeResponse(
      false,
      `Applications for this job is currently ${job.status}!`
    );
  }

  //let application = await applicationRepository.findApplicationByMatch({
  //  job: jobId,
  //  talent: user._id,
  //});

  let application: (IApplication & Document) | null =
      await applicationRepository.findApplicationByMatch(
        { talent: user._id, job: jobId }
      );

  if (!application) {
    return makeResponse(false, "Job application not found", {}, 404);
  }

  if (!application.canTakeAssessment()) {
    const days = calculateTimeLeft(application.assessmentRetryDate!);
    return makeResponse(
      false,
      `Sorry, you cannot take this assessment at the moment, retry ${days}`,
      {},
      403
    );
  }

  const aiConfig = await findAIconfigById(job.aiConfig as string);
  if (!aiConfig) {
    return makeResponse(false, "AI configuration for job not found!", {}, 404);
  }

  if (!aiConfig.personalityEvaluation) {
    return makeResponse(
      false,
      "This feature was not configured for this job!",
      {},
      400
    );
  }

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

  // Update application status based on score
  application.setAssessmentRetryDate();
  application = await applicationRepository.processNextStage(
    user,
    application,
    ScreeningStage.Personality
  );

  application.mbtiType = mbtiType;

  await application.save();

  return makeResponse(true, "Personality evaluation completed", {
    application,
    mbtiType,
  });
};
