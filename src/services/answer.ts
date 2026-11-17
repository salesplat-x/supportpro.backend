import { AppDataSource } from "../database/dataSource.js";
import { Answer } from "../entities/Answer.js";
import { Question } from "../entities/Question.js";
import { Application } from "../entities/Application.js";
import { User } from "../entities/User.js";
import { Job } from "../entities/Job.js";
import { IsNull, type EntityManager } from "typeorm";
import { NotFoundError, ValidationError, AuthorizationError, ConflictError } from "../utils/errors";
import { QuestionType, JobStatus, ApplicationStatus, ScreeningStage } from "../types/enums.js";
import { calculateTimeLeft } from "../utils/text.js";
import * as AI from "../utils/integrations/openai.js";
import {
  canTakeAssessment,
  getAssessmentRetryDate,
  hasReachedStage,
  processNextStage,
  stageMoveColumns,
} from "./applicationStage.js";
import { assertStageReached } from "./question.js";
import { notifyStageReached } from "./talentNotifications.js";
import { mergeSubmittedAnswers } from "../utils/answerResponses.js";
import { MAX_ANSWER_SCORE } from "../utils/gradedAnswers.js";
import logger from "../utils/logger.js";
import { claimRowById, STALE_LOCK_INTERVAL } from "../utils/durableJobs.js";
import { hideAssessmentResultsFromCandidate } from "./application.js";

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
  responses: IResponse[],
  manager: EntityManager = AppDataSource.manager
): Promise<Answer> => {
  const repo = manager.getRepository(Answer);
  const answer = await repo.findOne({
    where: {
      userId: filter.userId,
      roleId: filter.roleId != null ? filter.roleId : IsNull(),
      jobId: filter.jobId != null ? filter.jobId : IsNull(),
      questionType: filter.questionType,
    },
  });

  if (answer) {
    answer.responses = responses;
    return repo.save(answer);
  }

  const newAnswer = repo.create({
    userId: filter.userId,
    roleId: filter.roleId ?? null,
    jobId: filter.jobId ?? null,
    questionType: filter.questionType,
    responses,
  });
  return repo.save(newAnswer);
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

  const user = await userRepo().findOne({ where: { id: userId } });
  const applicationId = application.id;
  application = await AppDataSource.transaction(async (manager) => {
    const locked = await manager.findOne(Application, {
      where: { id: applicationId },
      lock: { mode: "pessimistic_write" },
    });
    if (!locked || locked.currentStage !== ScreeningStage.Personalized) {
      throw new ConflictError("This stage is no longer active for this application");
    }
    locked.personalizedScore = scorePercent;
    locked.personalizedAttempts = (locked.personalizedAttempts ?? 0) + 1;

    const minScore = aiConfig.minPrescreeningScore ?? 0;
    const MAX_ATTEMPTS = 2; // 1 initial + 1 retry
    const passed = scorePercent >= minScore;
    const attemptsExhausted = locked.personalizedAttempts >= MAX_ATTEMPTS;

    const open =
      locked.status === ApplicationStatus.Pending ||
      locked.status === ApplicationStatus.RetakeAssessment;
    let moved = locked;
    if (open && (passed || attemptsExhausted) && user) {
      moved = await processNextStage(user, locked, ScreeningStage.Personalized, aiConfig);
    } else if (open && !passed && !attemptsExhausted) {
      locked.status = ApplicationStatus.RetakeAssessment;
    }

    await manager.update(Application, applicationId, {
      personalizedScore: moved.personalizedScore,
      personalizedAttempts: moved.personalizedAttempts,
      ...stageMoveColumns(moved),
    });
    return moved;
  });
  await notifyStageReached(applicationId);

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

  const application = await applicationRepo().findOne({
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
    hasReachedStage(stages, application.currentStage, ScreeningStage.Personality) ||
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
    throw new ValidationError("The AI returned an invalid personality evaluation");
  }

  const user = await userRepo().findOne({ where: { id: userId } });

  // Claim the result first so a parallel submit that lost never moves the stage
  // or starts the match verdict, then write only the columns this flow changes:
  // a full save would write back stale scores saved while the AI ran. The row
  // stays locked until commit, so the match verdict reads the committed result.
  await AppDataSource.transaction(async (manager) => {
    const claimed = await manager.update(
      Application,
      { id: application.id, mbtiType: IsNull() },
      { mbtiType }
    );
    if (!claimed.affected) {
      throw new ConflictError("Personality test already completed for this application");
    }
    application.mbtiType = mbtiType;
    if (user && application.currentStage === ScreeningStage.Personality) {
      const moved = await processNextStage(user, application, ScreeningStage.Personality, aiConfig);
      await manager.update(Application, moved.id, stageMoveColumns(moved));
    }
    await saveOrUpdateAnswer(
      { userId, jobId, questionType: QuestionType.Personality },
      mergeSubmittedAnswers(answers, responses),
      manager
    );
  });
  await notifyStageReached(application.id);

  // Day 6: the AI judges how the saved type fits the job. The candidate
  // doesn't wait for it; a failure leaves the fit empty for the recruiter to retry.
  void savePersonalityFit(application.id);

  const fresh = await applicationRepo().findOneByOrFail({ id: application.id });
  return { application: hideAssessmentResultsFromCandidate(fresh), mbtiType, score: mbtiType };
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

const CLAIM_PERSONALITY_FIT_SQL = `
  UPDATE "applications"
  SET "personalityFitLockedAt" = NOW()
  WHERE "id" = $1
    AND "mbtiType" IS NOT NULL
    AND "personalityFitScore" IS NULL
    AND ("personalityFitLockedAt" IS NULL OR "personalityFitLockedAt" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  RETURNING "id"
`;

export type PersonalityFitOutcome =
  | { status: "saved"; personalityFitScore: number; personalityFitReason: string }
  | { status: "busy" }
  | { status: "failed" };

/**
 * Asks the AI how the application's saved MBTI type fits its job and stores the
 * score and reason. Claims the row first so two callers never both call the AI.
 * Never throws.
 */
export const savePersonalityFit = async (applicationId: string): Promise<PersonalityFitOutcome> => {
  try {
    if (!(await claimRowById(CLAIM_PERSONALITY_FIT_SQL, applicationId))) {
      return { status: "busy" };
    }
  } catch (error) {
    logger.warn(
      `Personality fit for application ${applicationId}: claim failed: ${errorText(error)}`
    );
    return { status: "failed" };
  }

  try {
    const application = await applicationRepo().findOne({
      where: { id: applicationId },
      relations: { job: { role: true } },
    });
    const job = application?.job;
    if (!application?.mbtiType || !job) return { status: "failed" };
    const mbtiType = application.mbtiType;

    const response = await AI.evaluatePersonalityFit({
      mbtiType,
      job: {
        title: job.role?.name ?? null,
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
        `Personality fit for application ${applicationId}: unusable AI reply, left empty`
      );
      return { status: "failed" };
    }
    const result = await applicationRepo().update(
      { id: applicationId, mbtiType },
      { ...fit, personalityFitLockedAt: null }
    );
    return result.affected ? { status: "saved", ...fit } : { status: "failed" };
  } catch (error) {
    logger.warn(
      `Personality fit for application ${applicationId} failed, left empty: ${errorText(error)}`
    );
    return { status: "failed" };
  } finally {
    await applicationRepo()
      .update(
        { id: applicationId, personalityFitScore: IsNull() },
        { personalityFitLockedAt: null }
      )
      .catch((error: unknown) =>
        logger.warn(
          `Personality fit for application ${applicationId}: unlock failed: ${errorText(error)}`
        )
      );
  }
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

type CompanyAssessmentType = QuestionType.ProblemSolving | QuestionType.CultureFit;

const COMPANY_ASSESSMENT = {
  [QuestionType.ProblemSolving]: {
    label: "problem-solving",
    flag: "problemSolvingAssessment",
    assigned: "problemSolvingQuestions",
    score: "problemSolvingScore",
    stage: ScreeningStage.ProblemSolving,
  },
  [QuestionType.CultureFit]: {
    label: "culture-fit",
    flag: "cultureFitAssessment",
    assigned: "cultureFitQuestions",
    score: "cultureFitScore",
    stage: ScreeningStage.CultureFit,
  },
} as const;

export interface CompanyAssessmentAnswersPayload {
  jobId: string;
  answers: Record<string, number>;
}

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

  let applicationId = "";
  const result = await AppDataSource.transaction(async (manager) => {
    const application = await manager.findOne(Application, {
      where: { jobId, talentId: userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!application) {
      throw new ValidationError("You must apply for this job before this stage is available");
    }
    if (application[settings.score] !== null && application[settings.score] !== undefined) {
      throw new ConflictError(`You have already submitted your ${settings.label} answers`);
    }
    assertStageReached(application, settings.stage, settings.label);
    applicationId = application.id;
    const assignedIds = application[settings.assigned] ?? [];
    if (assignedIds.length === 0) {
      throw new ValidationError(`Load your ${settings.label} questions before answering them`);
    }

    const questions = await manager
      .getRepository(Question)
      .createQueryBuilder("q")
      .whereInIds(assignedIds)
      .andWhere("q.job_id = :jobId", { jobId })
      .andWhere("q.type = :type", { type })
      .getMany();
    if (
      questions.length !== assignedIds.length ||
      questions.some((q) => !q.options?.length || q.correctOption === null)
    ) {
      throw new ValidationError(
        `Your ${settings.label} questions have changed. Please reload them and answer again.`
      );
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

    const byId = new Map(questions.map((q) => [q.id, q]));
    const responses = assignedIds.map((id) => {
      const question = byId.get(id)!;
      const options = question.options!;
      const selectedOption = answers[id]!;
      if (selectedOption >= options.length) {
        throw new ValidationError(`Pick one of the ${options.length} options for every question`);
      }
      const correct = selectedOption === question.correctOption;
      return {
        questionId: id,
        answer: options[selectedOption]!,
        selectedOption,
        score: correct ? MAX_ANSWER_SCORE : 0,
      };
    });
    const correctCount = responses.filter((r) => r.score === MAX_ANSWER_SCORE).length;
    const score = Math.round((100 * correctCount) / responses.length);

    await manager.query(`UPDATE "applications" SET "${settings.score}" = $1 WHERE id = $2`, [
      score,
      application.id,
    ]);
    await manager.save(
      Answer,
      manager.create(Answer, { userId, jobId, questionType: type, responses })
    );

    if (
      application.currentStage === settings.stage &&
      application.status === ApplicationStatus.Pending
    ) {
      const talent = await manager.findOne(User, { where: { id: userId } });
      if (talent) {
        const moved = await processNextStage(talent, application, settings.stage, job.aiConfig);
        await manager.update(Application, application.id, stageMoveColumns(moved));
      }
    }

    return { submitted: true as const, questionType: type, answered: responses.length };
  });
  await notifyStageReached(applicationId);
  return result;
};
