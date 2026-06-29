import { AppDataSource } from "../database/dataSource.js";
import { Application, Job, Question, Role, TalentEmbedding, User } from "../entities";
import { NotFoundError, ValidationError, AuthorizationError } from "../utils/errors";
import { QuestionType, JobStatus } from "../types/enums.js";
import { calculateTimeLeft, sortDirection } from "../utils/text.js";
import * as AI from "../utils/integrations/openai.js";

const questionRepo = () => AppDataSource.getRepository(Question);
const roleRepo = () => AppDataSource.getRepository(Role);
const jobRepo = () => AppDataSource.getRepository(Job);
const applicationRepo = () => AppDataSource.getRepository(Application);

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

    if (!canTakeAssessment(application.assessmentRetryDate)) {
      const days = calculateTimeLeft(application.assessmentRetryDate!);
      throw new AuthorizationError(
        `Sorry, you cannot take this assessment at the moment, retry ${days}`
      );
    }

    const questionIds = application.personalizedQuestions ?? [];
    if (questionIds.length === 0) return [];

    return questionRepo().createQueryBuilder("q").whereInIds(questionIds).getMany();
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

    const limit = Number(payload.limit) || 50;
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

  if (application?.personalizedQuestions?.length) {
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
    throw new ValidationError("Error with LLM");
  }

  const questions: string[] = JSON.parse(response.message.content).questions;

  const questionEntities = questions.map((q) =>
    questionRepo().create({
      type: QuestionType.Personalized,
      question: q,
      jobId,
    })
  );
  const savedQuestions = await questionRepo().save(questionEntities);
  const questionIds = savedQuestions.map((q) => q.id);

  if (application) {
    application.personalizedQuestions = questionIds;
    application = await applicationRepo().save(application);
  } else {
    application = await applicationRepo().save(
      applicationRepo().create({
        jobId,
        talentId,
        recruiterId: aiConfig.recruiterId,
        applicationType: "by application" as Application["applicationType"],
        stages: aiConfig.stages,
        personalizedQuestions: questionIds,
      })
    );
    await jobRepo()
      .createQueryBuilder()
      .update(Job)
      .set({ noOfApplicants: () => '"noOfApplicants" + 1' })
      .where('id = :id', { id: jobId })
      .execute();
  }

  return { questions: savedQuestions, application };
};

export interface GeneratePersonalityQuestionPayload {
  jobId: string;
  dichotomyPair: string;
}

export const generatePersonalityQuestion = async (
  payload: GeneratePersonalityQuestionPayload
): Promise<Question> => {
  const { jobId, dichotomyPair } = payload;

  const jobForPersonality = await jobRepo().findOne({ where: { id: jobId } });
  if (!jobForPersonality) {
    throw new NotFoundError("Job not found");
  }

  const response = await AI.getPersonalityEvaluationQuestion(
    jobForPersonality.jobBrief,
    dichotomyPair
  );
  if (!response || !response.message.content) {
    throw new ValidationError("Error with LLM");
  }
  const questionText: string = JSON.parse(response.message.content).question;

  const existing = await questionRepo().findOne({
    where: { jobId, type: QuestionType.Personality, criteria: dichotomyPair },
  });

  if (existing) {
    existing.question = questionText;
    return questionRepo().save(existing);
  }

  const q = questionRepo().create({
    type: QuestionType.Personality,
    question: questionText,
    jobId,
    criteria: dichotomyPair,
  });
  return questionRepo().save(q);
};
