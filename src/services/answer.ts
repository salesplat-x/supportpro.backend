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
import { canTakeAssessment, getAssessmentRetryDate, processNextStage } from "./applicationStage.js";

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

  let responseArray: IResponse[];
  try {
    responseArray = JSON.parse(response.message.content).responses;
  } catch {
    throw new ValidationError("Error with LLM");
  }

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

  if (application.currentStage !== ScreeningStage.Personalized) {
    throw new ValidationError("This stage is not currently active for this application");
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

  let responseArray: IResponse[];
  try {
    responseArray = JSON.parse(response.message.content).responses;
  } catch {
    throw new ValidationError("Error with LLM");
  }

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
  application.personalizedAttempts = (application.personalizedAttempts ?? 0) + 1;

  const minScore = aiConfig.minPrescreeningScore ?? 0;
  const MAX_ATTEMPTS = 2; // 1 initial + 1 retry
  const passed = scorePercent >= minScore;
  const attemptsExhausted = application.personalizedAttempts >= MAX_ATTEMPTS;

  if (passed || attemptsExhausted) {
    const user = await userRepo().findOne({ where: { id: userId } });
    if (user) {
      application = await processNextStage(
        user,
        application,
        ScreeningStage.Personalized,
        aiConfig
      );
    }
  } else {
    application.currentStage = ScreeningStage.Personalized;
    application.status = ApplicationStatus.RetakeAssessment;
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

/** True when personality is the active stage, or was already passed without an MBTI result. */
const canSubmitPersonalityStage = (
  stages: Record<string, string>,
  currentStage: string
): boolean => {
  if (currentStage === ScreeningStage.Personality) return true;

  const values = new Set(Object.values(stages));
  const entry = Object.keys(stages).find((key) => !values.has(key));
  if (!entry) return false;

  let cursor: string | undefined = entry;
  let seenPersonality = false;
  while (cursor && cursor !== ScreeningStage.Completed) {
    if (cursor === ScreeningStage.Personality) {
      seenPersonality = true;
    }
    if (cursor === currentStage) {
      return seenPersonality;
    }
    cursor = stages[cursor];
  }

  return (
    currentStage === ScreeningStage.Completed &&
    Object.prototype.hasOwnProperty.call(stages, ScreeningStage.Personality)
  );
};

export const evaluatePersonalityType = async (
  userId: string,
  payload: EvaluatePersonalityPayload
): Promise<{ application: Application; mbtiType: string; score: string }> => {
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

  const stages = (application.stages ?? {}) as Record<string, string>;

  if (application.mbtiType) {
    throw new ValidationError("Personality test already completed for this application");
  }

  const aiConfig = job.aiConfig;
  if (!aiConfig) {
    throw new NotFoundError("AI configuration for job not found");
  }

  if (!aiConfig.personalityEvaluation) {
    throw new ValidationError("This feature was not configured for this job");
  }

  const appHasPersonalityStage = Object.prototype.hasOwnProperty.call(
    stages,
    ScreeningStage.Personality
  );
  const configHasPersonalityStage = Object.prototype.hasOwnProperty.call(
    aiConfig.stages ?? {},
    ScreeningStage.Personality
  );

  // Allow when:
  // 1) personality is the current stage, or already passed without an MBTI result, or
  // 2) personality was attached to the job after this application was created
  //    (present on AI config stages but missing from the application pipeline).
  const allowed =
    canSubmitPersonalityStage(stages, application.currentStage) ||
    (!appHasPersonalityStage && configHasPersonalityStage);

  if (!allowed) {
    throw new ValidationError("This stage is not currently active for this application");
  }

  const questionIds = Object.keys(answers);

  // The expected total is however many personality questions were actually
  // generated for this job (sum across all four dichotomy pairs, each
  // independently configured) — not a fixed count.
  const jobPersonalityQuestions = await questionRepo().find({
    where: { jobId, type: QuestionType.Personality },
  });

  if (questionIds.length !== jobPersonalityQuestions.length) {
    throw new ValidationError(
      `You must answer exactly ${jobPersonalityQuestions.length} questions`
    );
  }

  const questionsById = new Map(jobPersonalityQuestions.map((q) => [q.id, q]));
  if (!questionIds.every((id) => questionsById.has(id))) {
    throw new ValidationError("One or more questions do not belong to job");
  }

  const questions = questionIds.map((id) => questionsById.get(id)!);

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
  if (!mbtiType || typeof mbtiType !== "string") {
    throw new ValidationError("OpenAI returned an invalid personality evaluation");
  }

  await saveOrUpdateAnswer({ userId, jobId, questionType: QuestionType.Personality }, responses);

  const user = await userRepo().findOne({ where: { id: userId } });
  if (user && application.currentStage === ScreeningStage.Personality) {
    application = await processNextStage(user, application, ScreeningStage.Personality, aiConfig);
  }
  application.mbtiType = mbtiType;
  application = await applicationRepo().save(application);

  return { application, mbtiType, score: mbtiType };
};
