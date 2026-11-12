import { In } from "typeorm";
import type { EntityManager } from "typeorm";

import { AppDataSource } from "../database/dataSource.js";
import { AIConfig } from "../entities/AIConfig.js";
import { Answer } from "../entities/Answer.js";
import { Application } from "../entities/Application.js";
import { Job } from "../entities/Job.js";
import { NotFoundError, ValidationError } from "../utils/errors";
import { UserRole, ScreeningStage, QuestionType, type AiInterviewMode } from "../types/enums.js";
import { assertCompanyResourceAccess, getActiveOrganizationId } from "./organizationScope.js";

const aiConfigRepo = () => AppDataSource.getRepository(AIConfig);

export interface AIConfigPayload {
  name?: string | null;
  jobId?: string;
  prescreeningAssessment?: boolean;
  minPrescreeningScore?: number | null;
  cvSimilarity?: boolean;
  minCvSimilarityScore?: number | null;
  personalizedAssessment?: boolean;
  noPersonalizedQuestions?: number;
  recruiterGuide?: string | null;
  uploadedQuestions?: string[] | null;
  personalityEvaluation?: boolean;
  noOfEIQuestions?: number | null;
  noOfSNQuestions?: number | null;
  noOfTFQuestions?: number | null;
  noOfJPQuestions?: number | null;
  problemSolvingAssessment?: boolean;
  noOfProblemSolvingQuestions?: number | null;
  cultureFitAssessment?: boolean;
  noOfCultureFitQuestions?: number | null;
  aiInterview?: boolean;
  aiInterviewMode?: AiInterviewMode | null;
}

const ASSESSMENT_SWITCHES = [
  { flag: "problemSolvingAssessment", count: "noOfProblemSolvingQuestions" },
  { flag: "cultureFitAssessment", count: "noOfCultureFitQuestions" },
] as const;

export const assertAssessmentCounts = (merged: AIConfigPayload): void => {
  for (const { flag, count } of ASSESSMENT_SWITCHES) {
    if (merged[flag] === true && (merged[count] === null || merged[count] === undefined)) {
      throw new ValidationError(`${count} is required when ${flag} is on`);
    }
  }
  if (merged.aiInterview === true && !merged.aiInterviewMode) {
    throw new ValidationError("aiInterviewMode is required when aiInterview is on");
  }
};

export interface StagesResult {
  stages: Record<string, string>;
  entryStage: ScreeningStage;
}

// Fixed pipeline order: Personality -> Personalized -> Prescreening -> CvSimilarity -> Completed,
// skipping any stage the recruiter didn't enable for this job.
const STAGE_ORDER: Array<{ flag: keyof AIConfigPayload; stage: ScreeningStage }> = [
  { flag: "personalityEvaluation", stage: ScreeningStage.Personality },
  { flag: "personalizedAssessment", stage: ScreeningStage.Personalized },
  { flag: "prescreeningAssessment", stage: ScreeningStage.Prescreening },
  { flag: "cvSimilarity", stage: ScreeningStage.CvSimilarity },
  { flag: "aiInterview", stage: ScreeningStage.AiInterview },
];

export const createStages = (config: AIConfigPayload): StagesResult => {
  const enabled = STAGE_ORDER.filter((o) => config[o.flag]).map((o) => o.stage);

  const stages: Record<string, string> = {};
  for (let i = 0; i < enabled.length; i++) {
    stages[enabled[i]!] = enabled[i + 1] ?? ScreeningStage.Completed;
  }

  return { stages, entryStage: enabled[0] ?? ScreeningStage.Completed };
};

// Recomputes the pipeline for applications on jobs linked to `configId` that
// haven't engaged with the AI screening at all yet — no recorded score, MBTI
// result, or submitted Answer for either the personality or personalized
// question sets. Applications with any recorded progress are left untouched
// so an edit mid-way through a talent's screening can't yank the ground out
// from under them.
export const resyncUntouchedApplications = async (
  manager: EntityManager,
  configId: string,
  stages: Record<string, string>,
  entryStage: ScreeningStage
): Promise<void> => {
  const jobs = await manager.find(Job, { where: { aiConfigId: configId }, select: { id: true } });
  if (jobs.length === 0) return;
  const jobIds = jobs.map((j) => j.id);

  const applications = await manager.find(Application, { where: { jobId: In(jobIds) } });
  const candidates = applications.filter(
    (app) => app.personalizedScore === null && !app.cvSimilarityAttempts && app.mbtiType === null
  );
  if (candidates.length === 0) return;

  const talentIds = [...new Set(candidates.map((a) => a.talentId))];
  const answers = await manager.find(Answer, {
    where: {
      userId: In(talentIds),
      jobId: In(jobIds),
      questionType: In([QuestionType.Personalized, QuestionType.Personality]),
    },
    select: { userId: true, jobId: true },
  });
  const answeredKeys = new Set(answers.map((a) => `${a.userId}:${a.jobId}`));

  const untouched = candidates.filter((app) => !answeredKeys.has(`${app.talentId}:${app.jobId}`));
  if (untouched.length === 0) return;

  const toSave = untouched.map((app) => ({
    ...app,
    stages,
    currentStage: entryStage as Application["currentStage"],
  }));
  await manager.save(Application, toSave);
};

export const createAIConfig = async (
  userId: string,
  userRole: UserRole,
  payload: AIConfigPayload
): Promise<AIConfig> => {
  if (!payload.jobId) {
    throw new ValidationError("jobId is required");
  }

  // Pre-screening is a mandatory stage — never trust a client-supplied value.
  const normalizedPayload: AIConfigPayload = { ...payload, prescreeningAssessment: true };
  assertAssessmentCounts(normalizedPayload);
  const { stages } = createStages(normalizedPayload);

  return AppDataSource.transaction(async (manager) => {
    const job = await manager.findOne(Job, { where: { id: payload.jobId } });
    if (!job) {
      throw new NotFoundError("Job not found");
    }
    await assertCompanyResourceAccess(userId, userRole, job.organizationId, job.postedById);

    const config = manager.create(AIConfig, {
      ...normalizedPayload,
      recruiterId: userId,
      organizationId: job.organizationId,
      stages,
    });
    const saved = await manager.save(AIConfig, config);
    await manager.update(Job, { id: payload.jobId }, { aiConfigId: saved.id });
    return saved;
  });
};

export const updateAIConfig = async (
  userId: string,
  userRole: UserRole,
  configId: string,
  payload: AIConfigPayload
): Promise<AIConfig> => {
  const config = await aiConfigRepo().findOne({ where: { id: configId } });
  if (!config) {
    throw new NotFoundError("Configuration not found");
  }

  await assertCompanyResourceAccess(userId, userRole, config.organizationId, config.recruiterId);

  // Pre-screening is a mandatory stage — never trust a client-supplied value.
  const normalizedPayload: AIConfigPayload = { ...payload, prescreeningAssessment: true };
  assertAssessmentCounts({ ...config, ...normalizedPayload });
  const { stages, entryStage } = createStages({ ...config, ...normalizedPayload });

  return AppDataSource.transaction(async (manager) => {
    const updated = await manager.save(AIConfig, { ...config, ...normalizedPayload, stages });
    await resyncUntouchedApplications(manager, configId, stages, entryStage);
    return updated;
  });
};

export const allAIConfig = async (userId: string): Promise<AIConfig[]> => {
  const activeOrgId = await getActiveOrganizationId(userId);
  if (activeOrgId) {
    return aiConfigRepo().find({ where: { organizationId: activeOrgId } });
  }
  return aiConfigRepo().find({ where: { recruiterId: userId } });
};

export const fetchAIConfig = async (
  userId: string,
  userRole: UserRole,
  configId: string
): Promise<AIConfig> => {
  const config = await aiConfigRepo().findOne({ where: { id: configId } });
  if (!config) {
    throw new NotFoundError("Configuration not found");
  }
  await assertCompanyResourceAccess(userId, userRole, config.organizationId, config.recruiterId);
  return config;
};

export const deleteAIConfig = async (
  userId: string,
  userRole: UserRole,
  configId: string
): Promise<void> => {
  const config = await aiConfigRepo().findOne({ where: { id: configId } });
  if (!config) {
    throw new NotFoundError("Configuration not found");
  }
  await assertCompanyResourceAccess(userId, userRole, config.organizationId, config.recruiterId);
  await aiConfigRepo().remove(config);
};
