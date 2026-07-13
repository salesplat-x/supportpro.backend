import { AppDataSource } from "../database/dataSource.js";
import { AIConfig } from "../entities/AIConfig.js";
import { Job } from "../entities/Job.js";
import { NotFoundError, ConflictError, AuthorizationError } from "../utils/errors";
import { UserRole, ScreeningStage } from "../types/enums.js";

const aiConfigRepo = () => AppDataSource.getRepository(AIConfig);

const jobRepo = () => AppDataSource.getRepository(Job);

export interface AIConfigPayload {
  name?: string | null;
  jobId?: string;
  prescreeningAssessment?: boolean;
  minPrescreeningScore?: number | null;
  cvSimilarity?: boolean;
  minCvSimilarityScore?: number | null;
  noOfCvSimilarCandidates?: number | null;
  personalizedAssessment?: boolean;
  noPersonalizedQuestions?: number;
  recruiterGuide?: string | null;
  uploadedQuestions?: string[] | null;
  personalityEvaluation?: boolean;
}

// Build stages object based on recruiter selections (mirrors Mongoose createStages)
export const createStages = (config: AIConfigPayload): Record<string, string> => {
  const stages: Record<string, string> = {};
  let currentStage: string = ScreeningStage.Prescreening;

  if (config.cvSimilarity) {
    stages[currentStage] = ScreeningStage.CvSimilarity;
    currentStage = ScreeningStage.CvSimilarity;
  }
  if (config.personalizedAssessment) {
    stages[currentStage] = ScreeningStage.Personalized;
    currentStage = ScreeningStage.Personalized;
  }
  if (config.personalityEvaluation) {
    stages[currentStage] = ScreeningStage.Personality;
    currentStage = ScreeningStage.Personality;
  }
  stages[currentStage] = ScreeningStage.Completed;

  return stages;
};

export const createAIConfig = async (
  userId: string,
  payload: AIConfigPayload
): Promise<AIConfig> => {
  const name = payload.name ? payload.name.toLowerCase() : null;

  const existing = await aiConfigRepo().findOne({
    where: { recruiterId: userId, name: name ?? undefined },
  });
  if (existing) {
    throw new ConflictError("Configuration already existing with this name");
  }

  const stages = createStages(payload);

  const config = aiConfigRepo().create({
    ...payload,
    name,
    recruiterId: userId,
    stages,
  });

  const saved = await aiConfigRepo().save(config);

  // Link job to aiConfig
  if (payload.jobId) {
    await jobRepo().update({ id: payload.jobId }, { aiConfigId: saved.id });
  }

  return saved;
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

  if (config.recruiterId !== userId && userRole !== UserRole.Admin) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  if (payload.name) {
    const name = payload.name.toLowerCase();
    const existing = await aiConfigRepo().findOne({
      where: { recruiterId: userId, name },
    });
    if (existing && existing.id !== config.id) {
      throw new ConflictError("You already have a configuration with this name");
    }
    payload.name = name;
  }

  const stages = createStages({ ...config, ...payload });

  const updated = await aiConfigRepo().save({
    ...config,
    ...payload,
    stages,
  });

  return updated;
};

export const allAIConfig = async (userId: string): Promise<AIConfig[]> => {
  return aiConfigRepo().find({ where: { recruiterId: userId } });
};

export const fetchAIConfig = async (userId: string, configId: string): Promise<AIConfig> => {
  const config = await aiConfigRepo().findOne({ where: { id: configId } });
  if (!config) {
    throw new NotFoundError("Configuration not found");
  }
  if (config.recruiterId !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }
  return config;
};

export const deleteAIConfig = async (userId: string, configId: string): Promise<void> => {
  const config = await aiConfigRepo().findOne({ where: { id: configId } });
  if (!config) {
    throw new NotFoundError("Configuration not found");
  }
  if (config.recruiterId !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }
  await aiConfigRepo().remove(config);
};
