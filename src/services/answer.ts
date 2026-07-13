import { AppDataSource } from "../database/dataSource.js";
import { Answer } from "../entities/Answer.js";
import { Question } from "../entities/Question.js";
import { Application } from "../entities/Application.js";
import { User } from "../entities/User.js";
import { Job } from "../entities/Job.js";
import { IsNull } from "typeorm";
import { NotFoundError, ValidationError, AuthorizationError } from "../utils/errors";
import { QuestionType, JobStatus, ApplicationStatus, ScreeningStage } from "../types/enums.js";
import { calculateTimeLeft } from "../utils/text.js";
import * as AI from "../utils/integrations/openai.js";

const answerRepo = () => AppDataSource.getRepository(Answer);

const questionRepo = () => AppDataSource.getRepository(Question);

const applicationRepo = () => AppDataSource.getRepository(Application);

const jobRepo = () => AppDataSource.getRepository(Job);

const userRepo = () => AppDataSource.getRepository(User);

interface IResponse {
  questionId: string;
  answer: string;
  score?: number;
  dichotomyPreference?: string;
}

const canTakeAssessment = (assessmentRetryDate: Date | null): boolean => {
  if (!assessmentRetryDate) return true;
  return new Date() >= assessmentRetryDate;
};

const getAssessmentRetryDate = (days = 7): Date => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};

const saveOrUpdateAnswer = async (
  filter: {
    userId: string;
    roleId?: string | null;
    jobId?: string | null;
    questionType: QuestionType;
  },
  responses: IResponse[]
): Promise<Answer> => {
  const answer = await answerRepo().findOne({
    where: {
      userId: filter.userId,
      roleId: filter.roleId != null ? filter.roleId : IsNull(),
      jobId: filter.jobId != null ? filter.jobId : IsNull(),
      questionType: filter.questionType,
    },
  });

  if (answer) {
    answer.responses = responses;
    return answerRepo().save(answer);
  }

  const newAnswer = answerRepo().create({
    userId: filter.userId,
    roleId: filter.roleId ?? null,
    jobId: filter.jobId ?? null,
    questionType: filter.questionType,
    responses,
  });
  return answerRepo().save(newAnswer);
};

const processNextStage = async (
  talent: User,
  application: Application,
  stage: ScreeningStage
): Promise<Application> => {
  const stages = application.stages ?? {};
  const nextStage = stages[stage];

  if (!nextStage) {
    throw new ValidationError("Next stage not found");
  }

  application.currentStage = nextStage as Application["currentStage"];

  if (nextStage === ScreeningStage.Completed) {
    // Rank the application
    await rankApplication(talent, application);
    application.status = ApplicationStatus.Shortlisted;
  } else {
    application.status = ApplicationStatus.Pending;
  }

  return application;
};

const rankApplication = async (talent: User, application: Application): Promise<void> => {
  const prescreeningScore = talent.prescreeningScore ?? undefined;
  const scores = [
    application.cvSimilarityScore,
    application.personalizedScore,
    prescreeningScore,
  ].filter((s): s is number => s !== null && s !== undefined);

  const averageScore =
    scores.length > 0 ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : 0;

  application.averageScore = averageScore;

  const newRank =
    (await applicationRepo().count({
      where: { jobId: application.jobId },
    })) + 1;

  application.rank = newRank;
};

export interface AnswerPrescreeningPayload {
  roleId: string;
  answers: Record<string, string>;
}

export const answerPrescreening = async (
  userId: string,
  payload: AnswerPrescreeningPayload
): Promise<{ scorePercent: number }> => {
  const user = await userRepo().findOne({
    where: { id: userId },
    relations: { userRoles: true },
  });
  if (!user) {
    throw new NotFoundError("Authenticated user no longer exists");
  }

  if (!canTakeAssessment(user.assessmentRetryDate)) {
    const days = calculateTimeLeft(user.assessmentRetryDate!);
    throw new AuthorizationError(
      `Sorry, you cannot take this assessment at the moment, retry ${days}`
    );
  }

  const userRoleIds = (user.userRoles ?? []).map((r) => r.id);
  if (!userRoleIds.includes(payload.roleId)) {
    throw new AuthorizationError("User is not permitted to take assessment for this role");
  }

  const questionIds = Object.keys(payload.answers);
  const MAX_ANSWERS = 15;
  if (questionIds.length > MAX_ANSWERS) {
    throw new ValidationError(`Maximum length of answers ${MAX_ANSWERS} has been exceeded`);
  }

  // Get all questions by Id that belong to this role
  const questions = await questionRepo()
    .createQueryBuilder("q")
    .whereInIds(questionIds)
    .andWhere("q.role_id = :roleId", { roleId: payload.roleId })
    .getMany();

  if (questions.length !== questionIds.length) {
    throw new ValidationError("One or more questions do not belong to the role");
  }

  const questionsConstruct = questions.map((q) => ({
    question: q.question,
    questionId: q.id,
    criteria: q.criteria,
    answer: payload.answers[q.id]!,
  }));

  const questionsJSON = JSON.stringify(questionsConstruct);

  const response = await AI.gradeAssessmentAnswers(questionsJSON);
  if (!response || !response.message || !response.message.content) {
    throw new ValidationError("Error with LLM");
  }

  const responseArray: IResponse[] = JSON.parse(response.message.content).responses;

  if (responseArray.length !== questionsConstruct.length) {
    throw new ValidationError("Length of response array doesn't match length of input array");
  }

  let totalScore = 0;
  for (const res of responseArray) {
    if (res.score == null || res.score > 5) {
      throw new ValidationError("Invalid score received");
    }
    totalScore += res.score;
  }

  const maxScore = 5 * responseArray.length;
  const scorePercent = Number(((totalScore / maxScore) * 100).toFixed(2));

  // Save answers
  await saveOrUpdateAnswer(
    { userId, roleId: payload.roleId, questionType: QuestionType.Prescreening },
    responseArray
  );

  // Update user assessment retry date and score
  const retryDate = getAssessmentRetryDate();
  await userRepo().save({
    ...user,
    assessmentRetryDate: retryDate,
    prescreeningScore: scorePercent,
  });

  return { scorePercent };
};

export interface AnswerPersonalizedPayload {
  jobId: string;
  answers: Record<string, string>;
}

export const answerPersonalizedQuestions = async (
  userId: string,
  payload: AnswerPersonalizedPayload
): Promise<{ scorePercent: number; application: Application }> => {
  const { answers, jobId } = payload;

  if (!answers || Object.keys(answers).length === 0) {
    throw new ValidationError("No answers provided");
  }

  const job = await jobRepo().findOne({
    where: { id: jobId },
    relations: { aiConfig: true },
  });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (job.status === JobStatus.Closed) {
    throw new ValidationError(`Applications for this job is currently ${job.status}`);
  }

  let application = await applicationRepo().findOne({
    where: { jobId, talentId: userId },
  });
  if (!application) {
    throw new NotFoundError("Job application not found");
  }

  if (!canTakeAssessment(application.assessmentRetryDate)) {
    const days = calculateTimeLeft(application.assessmentRetryDate!);
    throw new AuthorizationError(
      `Sorry, you cannot take this assessment at the moment, retry ${days}`
    );
  }

  const aiConfig = job.aiConfig;
  if (!aiConfig) {
    throw new NotFoundError("AI configuration for job not found");
  }

  if (!aiConfig.personalizedAssessment) {
    throw new ValidationError("This feature was not configured for this job");
  }

  const questionIds = Object.keys(answers);
  const questions = await questionRepo()
    .createQueryBuilder("q")
    .whereInIds(questionIds)
    .andWhere("q.job_id = :jobId", { jobId })
    .getMany();

  const questionConstruct = questions.map((q) => ({
    question: q.question,
    questionId: q.id,
    answer: answers[q.id],
  }));

  const answersJSON = JSON.stringify(questionConstruct);

  const response = await AI.gradePersonalizedAnswers(answersJSON, aiConfig.recruiterGuide ?? "");
  if (!response || !response.message.content) {
    throw new ValidationError("Error with LLM");
  }

  const responseArray: IResponse[] = JSON.parse(response.message.content).responses;

  if (responseArray.length !== questionIds.length) {
    throw new ValidationError("Length of response array doesn't match length of input array");
  }

  const MAX_SCORE = 5;
  let totalScore = 0;
  for (const r of responseArray) {
    if ((r.score ?? 0) > MAX_SCORE) {
      throw new ValidationError("Score exceeds the maximum assignable score");
    }
    totalScore += r.score ?? 0;
  }

  const maxScore = MAX_SCORE * responseArray.length;
  const scorePercent = Number(((totalScore / maxScore) * 100).toFixed(2));

  application.personalizedScore = scorePercent;

  const minScore = aiConfig.minPrescreeningScore ?? 0;
  if (scorePercent < minScore) {
    application.currentStage = ScreeningStage.Personalized;
    application.status = ApplicationStatus.RetakeAssessment;
    application.assessmentRetryDate = getAssessmentRetryDate();
  } else {
    const user = await userRepo().findOne({ where: { id: userId } });
    if (user) {
      application = await processNextStage(user, application, ScreeningStage.Personalized);
    }
  }

  application = await applicationRepo().save(application);

  await saveOrUpdateAnswer(
    { userId, jobId, questionType: QuestionType.Personalized },
    responseArray
  );

  return { scorePercent, application };
};

export interface EvaluatePersonalityPayload {
  jobId: string;
  answers: Record<string, string>;
}

export const evaluatePersonalityType = async (
  userId: string,
  payload: EvaluatePersonalityPayload
): Promise<{ application: Application; mbtiType: string }> => {
  const { answers, jobId } = payload;

  const job = await jobRepo().findOne({
    where: { id: jobId },
    relations: { aiConfig: true },
  });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (job.status === JobStatus.Closed) {
    throw new ValidationError(`Applications for this job is currently ${job.status}`);
  }

  let application = await applicationRepo().findOne({
    where: { jobId, talentId: userId },
  });
  if (!application) {
    throw new NotFoundError("Job application not found");
  }

  if (!canTakeAssessment(application.assessmentRetryDate)) {
    const days = calculateTimeLeft(application.assessmentRetryDate!);
    throw new AuthorizationError(
      `Sorry, you cannot take this assessment at the moment, retry ${days}`
    );
  }

  const aiConfig = job.aiConfig;
  if (!aiConfig) {
    throw new NotFoundError("AI configuration for job not found");
  }

  if (!aiConfig.personalityEvaluation) {
    throw new ValidationError("This feature was not configured for this job");
  }

  const questionIds = Object.keys(answers);

  if (questionIds.length !== 4) {
    throw new ValidationError("You must answer exactly 4 questions");
  }

  const questions = await questionRepo()
    .createQueryBuilder("q")
    .whereInIds(questionIds)
    .andWhere("q.job_id = :jobId", { jobId })
    .andWhere("q.type = :type", { type: QuestionType.Personality })
    .getMany();

  if (questions.length !== questionIds.length) {
    throw new ValidationError("One or more questions do not belong to job");
  }

  const questionsConstruct = questions.map((q) => ({
    question: q.question,
    questionId: q.id,
    answer: answers[q.id],
    dichotomy: q.criteria,
  }));

  const questionsJSON = JSON.stringify(questionsConstruct);

  const response = await AI.evaluatePersonalityType(questionsJSON);
  if (!response || !response.message.content) {
    throw new ValidationError("Error with LLM");
  }

  const { mbtiType, responses } = JSON.parse(response.message.content);

  await saveOrUpdateAnswer({ userId, jobId, questionType: QuestionType.Personality }, responses);

  application.assessmentRetryDate = getAssessmentRetryDate();
  const user = await userRepo().findOne({ where: { id: userId } });
  if (user) {
    application = await processNextStage(user, application, ScreeningStage.Personality);
  }
  application.mbtiType = mbtiType;
  application = await applicationRepo().save(application);

  return { application, mbtiType };
};
