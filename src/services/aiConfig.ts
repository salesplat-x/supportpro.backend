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
  noOfEIQuestions?: number | null;
  noOfSNQuestions?: number | null;
  noOfTFQuestions?: number | null;
  noOfJPQuestions?: number | null;
}

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
];

export const createStages = (config: AIConfigPayload): StagesResult => {
  const enabled = STAGE_ORDER.filter((o) => config[o.flag]).map((o) => o.stage);

  const stages: Record<string, string> = {};
  for (let i = 0; i < enabled.length; i++) {
    stages[enabled[i]!] = enabled[i + 1] ?? ScreeningStage.Completed;
  }

  return { stages, entryStage: enabled[0] ?? ScreeningStage.Completed };
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

  const { stages } = createStages(payload);

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

  const { stages } = createStages({ ...config, ...payload });

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
