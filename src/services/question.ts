import { AppDataSource } from "../database/dataSource.js";
import {
  AIConfig,
  Application,
  Job,
  Question,
  Role,
  TalentEmbedding,
  User,
  Answer,
} from "../entities";
import {
  NotFoundError,
  ValidationError,
  AuthorizationError,
  AppError,
  ConflictError,
} from "../utils/errors";
import { QuestionType, JobStatus, UserRole } from "../types/enums.js";
import { calculateTimeLeft, sortDirection } from "../utils/text.js";
import * as AI from "../utils/integrations/openai.js";
import { answerTextForQuestion, type StoredResponse } from "../utils/answerResponses.js";
import { assertCompanyResourceAccess } from "./organizationScope.js";
import {
  CULTURE_FIT_GENERAL_CATEGORIES,
  DEFAULT_GENERATED_QUESTIONS,
  MAX_GENERATION_ATTEMPTS,
  MAX_QUESTION_POOL_PER_TYPE,
  PROBLEM_SOLVING_CATEGORIES,
} from "../config/assessmentQuestions.js";
import {
  parseGeneratedQuestions,
  GeneratedQuestionsParseError,
  type GeneratedQuestion,
} from "../utils/generatedQuestions.js";
import logger from "../utils/logger.js";

const questionRepo = () => AppDataSource.getRepository(Question);
const roleRepo = () => AppDataSource.getRepository(Role);
const jobRepo = () => AppDataSource.getRepository(Job);
const applicationRepo = () => AppDataSource.getRepository(Application);
const answerRepo = () => AppDataSource.getRepository(Answer);

const MAX_PAGE_SIZE = 100;
const PERSONALITY_POOL_MULTIPLIER = 2;

const canTakeAssessment = (assessmentRetryDate: Date | null): boolean => {
  if (!assessmentRetryDate) return true;
  return new Date() >= assessmentRetryDate;
};

export interface QuestionPayload {
  roleId?: string | null;
  jobId?: string | null;
  type: QuestionType;
  question: string;
  criteria?: string | null;
  category?: string | null;
}

export interface FetchQuestionsParams {
  questionType?: QuestionType;
  jobId?: string;
  roleId?: string;
  limit?: number | string;
  offset?: number | string;
  sort?: string;
}

export const createQuestion = async (payload: QuestionPayload): Promise<Question> => {
  if (payload.roleId) {
    const role = await roleRepo().findOne({ where: { id: payload.roleId } });
    if (!role) {
      throw new NotFoundError("Role does not exist");
    }
  }
  const question = questionRepo().create({
    roleId: payload.roleId ?? null,
    jobId: payload.jobId ?? null,
    type: payload.type,
    question: payload.question,
    criteria: payload.criteria ?? null,
    category: payload.category ?? null,
  });
  return questionRepo().save(question);
};

const withStoredAnswers = async (
  userId: string,
  jobId: string,
  questionType: QuestionType,
  questions: Question[]
): Promise<Question[]> => {
  if (questions.length === 0) return questions;
  const answer = await answerRepo().findOne({ where: { userId, jobId, questionType } });
  if (!answer) return questions;
  const responses = (answer.responses ?? []) as StoredResponse[];
  return questions.map((question, index) =>
    Object.assign(question, {
      answer: answerTextForQuestion(responses, question.id, question.question, index),
    })
  );
};

export const fetchQuestions = async (
  user: User,
  payload: FetchQuestionsParams
): Promise<Question[]> => {
  // Personalized questions from a job application
  if (payload.jobId && payload.questionType === QuestionType.Personalized) {
    const job = await jobRepo().findOne({ where: { id: payload.jobId } });
    if (!job) {
      throw new NotFoundError("Job not found");
    }

    const application = await applicationRepo().findOne({
      where: { jobId: payload.jobId, talentId: user.id },
    });
    if (!application) {
      throw new NotFoundError("Application record not found");
    }

    const questionIds = application.personalizedQuestions ?? [];
    if (questionIds.length === 0) return [];

    const questions = await questionRepo()
      .createQueryBuilder("q")
      .whereInIds(questionIds)
      .getMany();
    return withStoredAnswers(user.id, payload.jobId, QuestionType.Personalized, questions);
  }

  // Personality questions: a per-applicant random subset of the job's shared pool
  if (payload.jobId && payload.questionType === QuestionType.Personality) {
    const questions = await getOrAssignPersonalityQuestionsForApplicant(payload.jobId, user.id);
    return withStoredAnswers(user.id, payload.jobId, QuestionType.Personality, questions);
  }

  // Problem-solving / culture-fit questions carry scoring criteria: only the
  // job's company can see them (candidates get them once Day 4/5 serves them).
  if (
    payload.questionType === QuestionType.ProblemSolving ||
    payload.questionType === QuestionType.CultureFit
  ) {
    return fetchCompanyAssessmentQuestions(user, payload);
  }

  // Prescreening questions require a complete profile and matching role
  if (payload.questionType === QuestionType.Prescreening) {
    if (!user.userRoles?.length) {
      throw new ValidationError("User profile is incomplete");
    }

    if (!canTakeAssessment(user.assessmentRetryDate)) {
      const days = calculateTimeLeft(user.assessmentRetryDate!);
      throw new AuthorizationError(
        `Sorry, you cannot take this assessment at the moment, retry ${days}`
      );
    }

    const userRoleIds = user.userRoles.map((r) => r.id);
    if (payload.roleId && !userRoleIds.includes(payload.roleId)) {
      throw new AuthorizationError("User is not permitted to take assessment for this role");
    }

    const limit = Math.min(Number(payload.limit) || 50, MAX_PAGE_SIZE);
    const offset = Number(payload.offset) || 0;
    const order = sortDirection(payload.sort ?? "desc");

    return questionRepo().find({
      where: { roleId: payload.roleId ?? undefined },
      skip: offset,
      take: limit,
      order: { createdAt: order },
    });
  }

  // Generic fetch
  const limit = Number(payload.limit) || 50;
  const offset = Number(payload.offset) || 0;
  const order = sortDirection(payload.sort ?? "desc");

  const where: Record<string, unknown> = {};
  if (payload.questionType) where["type"] = payload.questionType;
  if (payload.jobId) where["jobId"] = payload.jobId;
  if (payload.roleId) where["roleId"] = payload.roleId;

  return questionRepo().find({
    where,
    skip: offset,
    take: limit,
    order: { createdAt: order },
  });
};

const COMPANY_ONLY_TYPES: QuestionType[] = [QuestionType.ProblemSolving, QuestionType.CultureFit];

export const fetchQuestion = async (
  questionId: string,
  user?: Pick<User, "id" | "userRole">
): Promise<Question> => {
  const question = await questionRepo().findOne({ where: { id: questionId } });
  if (!question) {
    throw new NotFoundError("Question not found");
  }
  if (COMPANY_ONLY_TYPES.includes(question.type)) {
    // Answered with 404 so outsiders can't tell the question exists.
    try {
      if (!user || !question.jobId) throw new AuthorizationError("Not a company member");
      await loadJobForCompanyMember(user, question.jobId);
    } catch (err) {
      if (err instanceof AuthorizationError || err instanceof NotFoundError) {
        throw new NotFoundError("Question not found");
      }
      throw err;
    }
  }
  return question;
};

export const deleteQuestion = async (userId: string, questionId: string): Promise<void> => {
  const question = await questionRepo().findOne({
    where: { id: questionId },
    relations: { job: true },
  });
  if (!question) {
    throw new NotFoundError("Question not found");
  }
  if (!question.job) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }
  await assertCompanyResourceAccess(
    userId,
    UserRole.Recruiter,
    question.job.organizationId,
    question.job.postedById
  );

  await questionRepo().remove(question);
};

export interface GeneratePersonalizedQuestionsPayload {
  jobId: string;
  talentId: string;
}

export const generatePersonalizedQuestions = async (
  payload: GeneratePersonalizedQuestionsPayload
): Promise<{ questions: Question[]; application: Application }> => {
  const { jobId, talentId } = payload;

  const existingJob = await jobRepo().findOne({
    where: { id: jobId },
    relations: { aiConfig: true },
  });
  if (!existingJob) {
    throw new NotFoundError("Job not found");
  }
  if (existingJob.status === JobStatus.Closed) {
    throw new ValidationError(`Applications for this job is currently ${existingJob.status}`);
  }

  const aiConfig = existingJob.aiConfig;
  if (!aiConfig) {
    throw new NotFoundError("AI configuration for job not found");
  }
  if (!aiConfig.personalizedAssessment) {
    throw new ValidationError("This feature was not configured for this job");
  }

  let application = await applicationRepo().findOne({
    where: { jobId, talentId },
  });
  if (!application) {
    throw new ValidationError("You must apply for this job before this stage is available");
  }

  if (application.personalizedQuestions?.length) {
    const questions = await questionRepo()
      .createQueryBuilder("q")
      .whereInIds(application.personalizedQuestions)
      .getMany();
    return {
      questions: await withStoredAnswers(talentId, jobId, QuestionType.Personalized, questions),
      application,
    };
  }

  const jobEntity = await jobRepo().findOne({ where: { id: jobId } });
  if (!jobEntity) {
    throw new NotFoundError("Job not found in embedding store");
  }
  const jobDescription = jobEntity.jobBrief;

  const talentEmbeddings = await AppDataSource.getRepository(TalentEmbedding).find({
    where: { userId: talentId },
    select: { cvText: true },
  });
  if (talentEmbeddings.length === 0) {
    throw new NotFoundError("Talent not found in embedding store");
  }
  const cv = talentEmbeddings.map((r) => r.cvText ?? "");

  const talent = await AppDataSource.getRepository(User).findOne({ where: { id: talentId } });
  const bio = talent?.bio ?? "";

  const response = await AI.generatePersonalizedQuestions(
    jobDescription,
    cv,
    bio,
    aiConfig.noPersonalizedQuestions,
    aiConfig.recruiterGuide ?? ""
  );
  if (!response || !response.message.content) {
    throw new ValidationError(
      "Failed to generate personalized questions from OpenAI. Check OPENAI_API_KEY and try again."
    );
  }

  let questions: string[];
  try {
    questions = JSON.parse(response.message.content).questions;
  } catch {
    throw new ValidationError("OpenAI returned an invalid personalized question response");
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new ValidationError("OpenAI returned no personalized questions");
  }

  const questionEntities = questions.map((q) =>
    questionRepo().create({
      type: QuestionType.Personalized,
      question: q,
      jobId,
    })
  );
  const savedQuestions = await questionRepo().save(questionEntities);
  const questionIds = savedQuestions.map((q) => q.id);

  application.personalizedQuestions = questionIds;
  application = await applicationRepo().save(application);

  return { questions: savedQuestions, application };
};

export interface GeneratePersonalityQuestionPayload {
  jobId: string;
  dichotomyPair: string;
  count?: number;
}

const DICHOTOMY_COUNT_FIELD: Record<string, keyof AIConfig> = {
  EI: "noOfEIQuestions",
  SN: "noOfSNQuestions",
  TF: "noOfTFQuestions",
  JP: "noOfJPQuestions",
};

const generateDichotomyQuestions = async (
  job: Job,
  dichotomyPair: string,
  count: number
): Promise<Question[]> => {
  const response = await AI.getPersonalityEvaluationQuestion(job.jobBrief, dichotomyPair, count);
  if (!response || !response.message.content) {
    throw new ValidationError(
      "Failed to generate personality questions from OpenAI. Check OPENAI_API_KEY and try again."
    );
  }
  let questionTexts: string[];
  try {
    questionTexts = JSON.parse(response.message.content).questions;
  } catch {
    throw new ValidationError("OpenAI returned an invalid personality question response");
  }
  if (!Array.isArray(questionTexts) || questionTexts.length === 0) {
    throw new ValidationError("OpenAI returned no personality questions");
  }

  const questionEntities = questionTexts.map((text) =>
    questionRepo().create({
      type: QuestionType.Personality,
      question: text,
      jobId: job.id,
      criteria: dichotomyPair,
    })
  );

  return questionRepo().save(questionEntities);
};

export const generatePersonalityQuestion = async (
  payload: GeneratePersonalityQuestionPayload
): Promise<Question[]> => {
  const { jobId, dichotomyPair, count: requestedCount } = payload;

  const jobForPersonality = await jobRepo().findOne({
    where: { id: jobId },
    relations: { aiConfig: true },
  });
  if (!jobForPersonality) {
    throw new NotFoundError("Job not found");
  }

  const existingCount = await questionRepo().count({
    where: { jobId, type: QuestionType.Personality, criteria: dichotomyPair },
  });

  let count = 1;
  if (existingCount === 0) {
    if (requestedCount != null) {
      count = requestedCount;
    } else {
      const countField = DICHOTOMY_COUNT_FIELD[dichotomyPair];
      const configuredCount = countField
        ? (jobForPersonality.aiConfig?.[countField] as number | null | undefined)
        : undefined;
      if (configuredCount == null) {
        throw new ValidationError(
          `No question count configured for dichotomy pair "${dichotomyPair}"`
        );
      }
      count = configuredCount;
    }
  }

  return generateDichotomyQuestions(jobForPersonality, dichotomyPair, count);
};

const DICHOTOMY_PAIRS = ["EI", "SN", "TF", "JP"] as const;

// Talent-safe counterpart to generatePersonalityQuestion: that endpoint is
// Recruiter-only and always generates one *more* question when any already
// exist, so it can't be called by a stuck talent to self-recover. This is
// truly idempotent — it only fills in pairs that have zero questions, never
// adds to a pair that already has some — so it's safe for a talent to call
// (including via automatic retry) without spamming duplicate questions.
export const ensurePersonalityQuestions = async (jobId: string): Promise<Question[]> => {
  const job = await jobRepo().findOne({ where: { id: jobId }, relations: { aiConfig: true } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (!job.aiConfig?.personalityEvaluation) {
    throw new ValidationError("This feature was not configured for this job");
  }

  for (const dichotomyPair of DICHOTOMY_PAIRS) {
    const existingCount = await questionRepo().count({
      where: { jobId, type: QuestionType.Personality, criteria: dichotomyPair },
    });
    if (existingCount > 0) continue;

    const countField = DICHOTOMY_COUNT_FIELD[dichotomyPair]!;
    const configuredCount = job.aiConfig[countField] as number | null | undefined;
    if (configuredCount == null) continue;

    await generateDichotomyQuestions(
      job,
      dichotomyPair,
      configuredCount * PERSONALITY_POOL_MULTIPLIER
    );
  }

  return questionRepo().find({ where: { jobId, type: QuestionType.Personality } });
};

const shuffle = <T>(items: T[]): T[] => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i]!;
    result[i] = result[j]!;
    result[j] = temp;
  }
  return result;
};

export const getOrAssignPersonalityQuestionsForApplicant = async (
  jobId: string,
  talentId: string
): Promise<Question[]> => {
  const application = await applicationRepo().findOne({ where: { jobId, talentId } });
  if (!application) {
    throw new ValidationError("You must apply for this job before this stage is available");
  }

  if (application.personalityQuestions?.length) {
    return questionRepo()
      .createQueryBuilder("q")
      .whereInIds(application.personalityQuestions)
      .getMany();
  }

  await ensurePersonalityQuestions(jobId);

  const job = await jobRepo().findOne({ where: { id: jobId }, relations: { aiConfig: true } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }

  const selectedIds: string[] = [];
  for (const dichotomyPair of DICHOTOMY_PAIRS) {
    const countField = DICHOTOMY_COUNT_FIELD[dichotomyPair]!;
    const configuredCount = job.aiConfig?.[countField] as number | null | undefined;
    if (!configuredCount) continue;

    const pool = await questionRepo().find({
      where: { jobId, type: QuestionType.Personality, criteria: dichotomyPair },
    });
    const selected = shuffle(pool).slice(0, configuredCount);
    selectedIds.push(...selected.map((q) => q.id));
  }

  application.personalityQuestions = selectedIds;
  await applicationRepo().save(application);

  return questionRepo().createQueryBuilder("q").whereInIds(selectedIds).getMany();
};

// ---------------------------------------------------------------------------
// Problem-solving and culture-fit questions (plan Day 3)
// ---------------------------------------------------------------------------

type CompanyAssessmentType = QuestionType.ProblemSolving | QuestionType.CultureFit;

const ASSESSMENT_LABEL: Record<CompanyAssessmentType, string> = {
  [QuestionType.ProblemSolving]: "problem-solving",
  [QuestionType.CultureFit]: "culture-fit",
};

/** Loads the job and checks the caller belongs to the company that owns it. */
const loadJobForCompanyMember = async (
  user: Pick<User, "id" | "userRole">,
  jobId: string,
  withOrganization = false
): Promise<Job> => {
  const job = await jobRepo().findOne({
    where: { id: jobId },
    relations: withOrganization ? { organization: true } : undefined,
  });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (user.userRole === UserRole.Talent) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }
  await assertCompanyResourceAccess(user.id, user.userRole, job.organizationId, job.postedById);
  return job;
};

const fetchCompanyAssessmentQuestions = async (
  user: User,
  payload: FetchQuestionsParams
): Promise<Question[]> => {
  if (!payload.jobId) {
    throw new ValidationError("jobId is required for this question type");
  }
  await loadJobForCompanyMember(user, payload.jobId);

  const limit = Math.min(Number(payload.limit) || 50, MAX_PAGE_SIZE);
  const offset = Number(payload.offset) || 0;
  return questionRepo().find({
    where: { jobId: payload.jobId, type: payload.questionType },
    skip: offset,
    take: limit,
    order: { createdAt: sortDirection(payload.sort ?? "asc") },
  });
};

const generationFailedError = (label: string) =>
  new AppError(
    502,
    "AI_GENERATION_FAILED",
    `We couldn't generate ${label} questions right now. Please try again in a moment.`
  );

const questionKey = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Calls the AI up to MAX_GENERATION_ATTEMPTS times, asking only for what is
 * still missing, and keeps every usable question. A malformed or short reply is
 * retried; a failed call is not, since runCompletion already retried transient
 * errors. If nothing usable comes back, a clear 502.
 */
const collectGeneratedQuestions = async (
  label: string,
  count: number,
  existing: string[],
  callAI: (
    remaining: number,
    avoid: string[]
  ) => Promise<{ message?: { content?: string | null } } | undefined>,
  parseOptions: { categories: readonly string[] }
): Promise<GeneratedQuestion[]> => {
  const collected: GeneratedQuestion[] = [];
  const seen = new Set(existing.map(questionKey));

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const remaining = count - collected.length;
    if (remaining <= 0) break;

    let content: string | null | undefined;
    try {
      const avoid = [...existing, ...collected.map((q) => q.question)];
      content = (await callAI(remaining, avoid))?.message?.content;
    } catch (err) {
      logger.warn(
        `AI ${label} question generation failed (attempt ${attempt}/${MAX_GENERATION_ATTEMPTS}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      break;
    }

    let parsed: GeneratedQuestion[];
    try {
      parsed = parseGeneratedQuestions(content, { max: remaining, ...parseOptions });
    } catch (err) {
      if (!(err instanceof GeneratedQuestionsParseError)) throw err;
      logger.warn(
        `AI ${label} question reply unusable (attempt ${attempt}/${MAX_GENERATION_ATTEMPTS}): ${err.message}`
      );
      continue;
    }

    for (const item of parsed) {
      const key = questionKey(item.question);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(item);
    }
  }

  if (collected.length === 0) {
    throw generationFailedError(label);
  }
  return collected;
};

const poolFullError = (type: CompanyAssessmentType) =>
  new ValidationError(
    `This job already has the maximum of ${MAX_QUESTION_POOL_PER_TYPE} ${ASSESSMENT_LABEL[type]} questions. Delete some before generating more.`
  );

/** How many more questions of this type the job may hold; 400 when it is full. */
const remainingPoolSpace = async (
  job: Job,
  type: CompanyAssessmentType,
  requested: number
): Promise<{ count: number; existing: string[] }> => {
  const existingRows = await questionRepo().find({
    where: { jobId: job.id, type },
    select: { id: true, question: true },
    order: { createdAt: "ASC" },
  });
  const space = MAX_QUESTION_POOL_PER_TYPE - existingRows.length;
  if (space <= 0) {
    throw poolFullError(type);
  }
  return { count: Math.min(requested, space), existing: existingRows.map((q) => q.question) };
};

/**
 * The pool is checked again under a lock on the job row, because another
 * request may have filled it or saved the same questions during the AI call.
 */
const saveGeneratedQuestions = (
  job: Job,
  type: CompanyAssessmentType,
  generated: GeneratedQuestion[]
): Promise<Question[]> =>
  AppDataSource.transaction(async (manager) => {
    await manager.findOne(Job, {
      where: { id: job.id },
      select: { id: true },
      lock: { mode: "pessimistic_write" },
    });
    const repo = manager.getRepository(Question);
    const pool = await repo.find({
      where: { jobId: job.id, type },
      select: { id: true, question: true },
    });
    const space = MAX_QUESTION_POOL_PER_TYPE - pool.length;
    if (space <= 0) {
      throw poolFullError(type);
    }

    const taken = new Set(pool.map((q) => questionKey(q.question)));
    const fresh = generated.filter((item) => !taken.has(questionKey(item.question)));
    if (fresh.length === 0) {
      throw new ConflictError(
        `These ${ASSESSMENT_LABEL[type]} questions were just added by another request. Refresh to see them.`
      );
    }

    return repo.save(
      fresh.slice(0, space).map((item) =>
        repo.create({
          type,
          jobId: job.id,
          question: item.question,
          category: item.category,
          criteria: item.criteria,
        })
      )
    );
  });

export interface GenerateAssessmentQuestionsPayload {
  jobId: string;
  count?: number;
}

export const generateProblemSolvingQuestions = async (
  user: Pick<User, "id" | "userRole">,
  payload: GenerateAssessmentQuestionsPayload
): Promise<{ questions: Question[] }> => {
  const type = QuestionType.ProblemSolving;
  const job = await loadJobForCompanyMember(user, payload.jobId);
  const { count, existing } = await remainingPoolSpace(
    job,
    type,
    payload.count ?? DEFAULT_GENERATED_QUESTIONS
  );

  // Job-agnostic by design: nothing about the job goes to the AI.
  const generated = await collectGeneratedQuestions(
    ASSESSMENT_LABEL[type],
    count,
    existing,
    (remaining, avoid) => AI.generateProblemSolvingQuestions({ count: remaining, avoid }),
    { categories: PROBLEM_SOLVING_CATEGORIES }
  );

  return { questions: await saveGeneratedQuestions(job, type, generated) };
};

export const generateCultureFitQuestions = async (
  user: Pick<User, "id" | "userRole">,
  payload: GenerateAssessmentQuestionsPayload
): Promise<{ questions: Question[]; basedOnCompanyValues: boolean }> => {
  const type = QuestionType.CultureFit;
  const job = await loadJobForCompanyMember(user, payload.jobId, true);
  const { count, existing } = await remainingPoolSpace(
    job,
    type,
    payload.count ?? DEFAULT_GENERATED_QUESTIONS
  );

  // No values yet (or a pre-tenancy job with no company): still useful — the
  // AI asks about general ways of working, and the caller is told so.
  const companyValues = job.organization?.companyValues ?? [];
  const basedOnCompanyValues = companyValues.length > 0;

  const generated = await collectGeneratedQuestions(
    ASSESSMENT_LABEL[type],
    count,
    existing,
    (remaining, avoid) =>
      AI.generateCultureFitQuestions({
        count: remaining,
        companyValues,
        companyName: job.organization?.name ?? null,
        jobBrief: job.jobBrief,
        avoid,
      }),
    { categories: basedOnCompanyValues ? companyValues : CULTURE_FIT_GENERAL_CATEGORIES }
  );

  return {
    questions: await saveGeneratedQuestions(job, type, generated),
    basedOnCompanyValues,
  };
};

// ---------------------------------------------------------------------------
// Problem-solving and culture-fit questions for candidates (plan Day 4)
// ---------------------------------------------------------------------------

/** What a candidate sees of a question: never the scoring criteria or category. */
export interface CandidateQuestion {
  id: string;
  question: string;
  questionType: QuestionType;
}

export const ASSESSMENT_SETTINGS = {
  [QuestionType.ProblemSolving]: {
    label: "problem-solving",
    flag: "problemSolvingAssessment",
    count: "noOfProblemSolvingQuestions",
    assigned: "problemSolvingQuestions",
    score: "problemSolvingScore",
  },
  [QuestionType.CultureFit]: {
    label: "culture-fit",
    flag: "cultureFitAssessment",
    count: "noOfCultureFitQuestions",
    assigned: "cultureFitQuestions",
    score: "cultureFitScore",
  },
} as const;

export const toCandidateQuestion = (q: Question): CandidateQuestion => ({
  id: q.id,
  question: q.question,
  questionType: q.type,
});

/**
 * Gives an applicant their problem-solving or culture-fit questions. The first
 * call picks a random set of the recruiter's chosen size from the job's pool and
 * stores it on the application; later calls return the same set.
 */
export const getOrAssignAssessmentQuestionsForApplicant = async (
  userId: string,
  type: CompanyAssessmentType,
  jobId: string
): Promise<{ questions: CandidateQuestion[] }> => {
  const settings = ASSESSMENT_SETTINGS[type];
  const job = await jobRepo().findOne({ where: { id: jobId }, relations: { aiConfig: true } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  const config = job.aiConfig;
  if (!config?.[settings.flag]) {
    throw new ValidationError(`The ${settings.label} test is not switched on for this job`);
  }
  // Locked so overlapping first loads can't hand the applicant two different sets.
  return AppDataSource.transaction(async (manager) => {
    const application = await manager.findOne(Application, {
      where: { jobId, talentId: userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!application) {
      throw new ValidationError("You must apply for this job before this stage is available");
    }

    const alreadyAssigned = application[settings.assigned] ?? [];
    if (alreadyAssigned.length) {
      const assigned = await manager
        .getRepository(Question)
        .createQueryBuilder("q")
        .whereInIds(alreadyAssigned)
        .getMany();
      // A recruiter deleted one of these before the applicant answered: serve a
      // fresh set rather than leave them unable to submit.
      const scored = application[settings.score] !== null;
      if (assigned.length === alreadyAssigned.length || scored) {
        const order = new Map(alreadyAssigned.map((id, i) => [id, i]));
        assigned.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
        return { questions: assigned.map(toCandidateQuestion) };
      }
    }

    const pool = await manager.find(Question, { where: { jobId, type } });
    if (pool.length === 0) {
      throw new AppError(
        409,
        "ASSESSMENT_NOT_READY",
        `The ${settings.label} test for this job isn't ready yet. Please try again later.`
      );
    }
    const count = config[settings.count] ?? pool.length;
    const selected = shuffle(pool).slice(0, count);
    await manager.update(Application, application.id, {
      [settings.assigned]: selected.map((q) => q.id),
    });
    return { questions: selected.map(toCandidateQuestion) };
  });
};
