import { AppDataSource } from "../database/dataSource.js";
import { Answer } from "../entities/Answer.js";
import { Question } from "../entities/Question.js";
import { Application } from "../entities/Application.js";
import { User } from "../entities/User.js";
import { Job } from "../entities/Job.js";
import { Role } from "../entities/Role.js";
import { IsNull } from "typeorm";
import {
  NotFoundError,
  ValidationError,
  AuthorizationError,
  AppError,
  ConflictError,
} from "../utils/errors";
import { QuestionType, JobStatus, ApplicationStatus, ScreeningStage } from "../types/enums.js";
import { calculateTimeLeft } from "../utils/text.js";
import * as AI from "../utils/integrations/openai.js";
import { canTakeAssessment, getAssessmentRetryDate, processNextStage } from "./applicationStage.js";
import { mergeSubmittedAnswers } from "../utils/answerResponses.js";
import {
  parseGradedAnswers,
  scorePercent,
  GradedAnswersParseError,
  type GradedAnswer,
} from "../utils/gradedAnswers.js";
import { MAX_GENERATION_ATTEMPTS } from "../config/assessmentQuestions.js";
import logger from "../utils/logger.js";

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

  await saveOrUpdateAnswer(
    { userId, roleId: payload.roleId, questionType: QuestionType.Prescreening },
    mergeSubmittedAnswers(payload.answers, responseArray)
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
    mergeSubmittedAnswers(answers, responseArray)
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

  // The expected set is the applicant's own sampled subset when one was
  // assigned; applications that reached this stage before per-applicant
  // sampling shipped fall back to the full job-level question set.
  const jobPersonalityQuestions = application.personalityQuestions?.length
    ? await questionRepo()
        .createQueryBuilder("q")
        .whereInIds(application.personalityQuestions)
        .getMany()
    : await questionRepo().find({ where: { jobId, type: QuestionType.Personality } });

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

  await saveOrUpdateAnswer(
    { userId, jobId, questionType: QuestionType.Personality },
    mergeSubmittedAnswers(answers, responses)
  );

  const user = await userRepo().findOne({ where: { id: userId } });
  if (user && application.currentStage === ScreeningStage.Personality) {
    application = await processNextStage(user, application, ScreeningStage.Personality, aiConfig);
  }
  application.mbtiType = mbtiType;
  application = await applicationRepo().save(application);

  // Day 6: right after the MBTI type is saved, the AI judges how it fits the
  // job. Only reached when the personality check is on (checked above).
  application = await savePersonalityFit(application, job, mbtiType);

  return { application, mbtiType, score: mbtiType };
};

/** Reads the AI's fit reply; anything not a 0-100 score with a reason is ignored. */
export const parsePersonalityFit = (
  content: string | null | undefined
): { personalityFitScore: number; personalityFitReason: string } | null => {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const { personalityFitScore, personalityFitReason } = (parsed ?? {}) as Record<string, unknown>;
  if (
    typeof personalityFitScore !== "number" ||
    !Number.isFinite(personalityFitScore) ||
    personalityFitScore < 0 ||
    personalityFitScore > 100 ||
    typeof personalityFitReason !== "string" ||
    !personalityFitReason.trim()
  ) {
    return null;
  }
  return { personalityFitScore, personalityFitReason: personalityFitReason.trim() };
};

const savePersonalityFit = async (
  application: Application,
  job: Job,
  mbtiType: string
): Promise<Application> => {
  try {
    const role = job.roleId
      ? await AppDataSource.getRepository(Role).findOne({ where: { id: job.roleId } })
      : null;
    const response = await AI.evaluatePersonalityFit({
      mbtiType,
      job: {
        title: role?.name ?? null,
        jobBrief: job.jobBrief,
        requirements: job.requirements ?? null,
        skills: job.skills ?? null,
        goals: job.goals ?? null,
        experienceLevel: job.experienceLevel,
      },
    });
    const fit = parsePersonalityFit(response?.message?.content);
    if (!fit) {
      logger.warn(
        `Personality fit for application ${application.id}: unusable AI reply, left empty`
      );
      return application;
    }
    Object.assign(application, fit);
    return await applicationRepo().save(application);
  } catch (error) {
    // The MBTI result is already saved; a failed fit call must not undo it.
    logger.warn(
      `Personality fit for application ${application.id} failed, left empty: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return application;
  }
};

// ---------------------------------------------------------------------------
// Problem-solving and culture-fit answers and scoring (plan Day 4)
// ---------------------------------------------------------------------------

type CompanyAssessmentType = QuestionType.ProblemSolving | QuestionType.CultureFit;

const COMPANY_ASSESSMENT = {
  [QuestionType.ProblemSolving]: {
    label: "problem-solving",
    flag: "problemSolvingAssessment",
    assigned: "problemSolvingQuestions",
    score: "problemSolvingScore",
  },
  [QuestionType.CultureFit]: {
    label: "culture-fit",
    flag: "cultureFitAssessment",
    assigned: "cultureFitQuestions",
    score: "cultureFitScore",
  },
} as const;

export interface CompanyAssessmentAnswersPayload {
  jobId: string;
  answers: Record<string, string>;
}

/**
 * Grades every answer, calling the AI up to MAX_GENERATION_ATTEMPTS times and
 * asking again only for answers still without a usable grade. Returns null if
 * any answer is still ungraded, so nothing partial is ever saved.
 */
const gradeAllAnswers = async (
  type: CompanyAssessmentType,
  items: AI.CompanyAssessmentAnswerItem[]
): Promise<Map<string, GradedAnswer> | null> => {
  const graded = new Map<string, GradedAnswer>();
  const label = COMPANY_ASSESSMENT[type].label;
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const remaining = items.filter((item) => !graded.has(item.questionId));
    if (remaining.length === 0) break;
    try {
      const reply = await AI.gradeCompanyAssessmentAnswers({ type, items: remaining });
      const parsed = parseGradedAnswers(
        reply?.message?.content,
        remaining.map((item) => item.questionId)
      );
      for (const grade of parsed) graded.set(grade.questionId, grade);
    } catch (err) {
      // A failed call or an unusable reply: log it and try again for what is missing.
      const what = err instanceof GradedAnswersParseError ? "reply unusable" : "call failed";
      logger.warn(
        `AI ${label} grading ${what} (attempt ${attempt}/${MAX_GENERATION_ATTEMPTS}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return graded.size === items.length ? graded : null;
};

/**
 * A candidate submits answers to the problem-solving or culture-fit questions
 * they were given. Each answer is graded 0-5 against its question's criteria;
 * the score is the total over the most possible, as a percentage, saved on the
 * application. One submission per test; the candidate isn't shown the score.
 */
export const submitCompanyAssessmentAnswers = async (
  userId: string,
  type: CompanyAssessmentType,
  payload: CompanyAssessmentAnswersPayload
): Promise<{ submitted: true; questionType: CompanyAssessmentType; answered: number }> => {
  const settings = COMPANY_ASSESSMENT[type];
  const { jobId, answers } = payload;

  const job = await jobRepo().findOne({ where: { id: jobId }, relations: { aiConfig: true } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (job.status === JobStatus.Closed) {
    throw new ValidationError(`Applications for this job is currently ${job.status}`);
  }
  if (!job.aiConfig?.[settings.flag]) {
    throw new ValidationError(`The ${settings.label} test is not switched on for this job`);
  }

  const application = await applicationRepo().findOne({ where: { jobId, talentId: userId } });
  if (!application) {
    throw new ValidationError("You must apply for this job before this stage is available");
  }
  if (application[settings.score] !== null && application[settings.score] !== undefined) {
    throw new ConflictError(`You have already submitted your ${settings.label} answers`);
  }
  const assignedIds = application[settings.assigned] ?? [];
  if (assignedIds.length === 0) {
    throw new ValidationError(`Load your ${settings.label} questions before answering them`);
  }

  const assigned = new Set(assignedIds);
  const answeredIds = Object.keys(answers);
  if (answeredIds.some((id) => !assigned.has(id))) {
    throw new ValidationError(`Only answer the ${settings.label} questions you were given`);
  }
  const missing = assignedIds.filter((id) => !answeredIds.includes(id));
  if (missing.length > 0) {
    throw new ValidationError(
      `Please answer all ${assignedIds.length} ${settings.label} questions (${missing.length} missing)`
    );
  }

  const questions = await questionRepo()
    .createQueryBuilder("q")
    .whereInIds(assignedIds)
    .andWhere("q.job_id = :jobId", { jobId })
    .andWhere("q.type = :type", { type })
    .getMany();
  if (questions.length !== assignedIds.length) {
    throw new ValidationError(
      `Some of your ${settings.label} questions are no longer available. Please contact the recruiter.`
    );
  }

  const items: AI.CompanyAssessmentAnswerItem[] = questions.map((q) => ({
    questionId: q.id,
    question: q.question,
    criteria: q.criteria ?? "",
    answer: answers[q.id]!.trim(),
    ...(type === QuestionType.CultureFit ? { companyValue: q.category ?? null } : {}),
  }));

  const graded = await gradeAllAnswers(type, items);
  if (!graded) {
    throw new AppError(
      502,
      "AI_GRADING_FAILED",
      `We couldn't score your ${settings.label} answers right now. Please try again in a moment.`
    );
  }

  const ordered = assignedIds.map((id) => graded.get(id)!);
  application[settings.score] = scorePercent(ordered.map((g) => g.score));

  await AppDataSource.transaction(async (manager) => {
    await manager.save(Application, application);
    await manager.save(
      Answer,
      manager.create(Answer, {
        userId,
        jobId,
        questionType: type,
        responses: ordered.map((g) => ({
          questionId: g.questionId,
          answer: answers[g.questionId]!.trim(),
          score: g.score,
          feedback: g.feedback,
        })),
      })
    );
  });

  return { submitted: true, questionType: type, answered: ordered.length };
};
