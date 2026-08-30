import { AppDataSource } from "../database/dataSource.js";
import { AIConfig, Application, Job, Question, Role, TalentEmbedding, User, Answer } from "../entities";
import { NotFoundError, ValidationError, AuthorizationError } from "../utils/errors";
import { QuestionType, JobStatus } from "../types/enums.js";
import { calculateTimeLeft, sortDirection } from "../utils/text.js";
import * as AI from "../utils/integrations/openai.js";

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
  const byId = new Map(answer.responses.map((r) => [r.questionId, r.answer]));
  return questions.map((question) =>
    Object.assign(question, { answer: byId.get(question.id) ?? null })
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

    const questions = await questionRepo().createQueryBuilder("q").whereInIds(questionIds).getMany();
    return withStoredAnswers(user.id, payload.jobId, QuestionType.Personalized, questions);
  }

  // Personality questions: a per-applicant random subset of the job's shared pool
  if (payload.jobId && payload.questionType === QuestionType.Personality) {
    const questions = await getOrAssignPersonalityQuestionsForApplicant(payload.jobId, user.id);
    return withStoredAnswers(user.id, payload.jobId, QuestionType.Personality, questions);
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

export const fetchQuestion = async (questionId: string): Promise<Question> => {
  const question = await questionRepo().findOne({ where: { id: questionId } });
  if (!question) {
    throw new NotFoundError("Question not found");
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
  if (!question.job || question.job.postedById !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

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
    return { questions, application };
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
