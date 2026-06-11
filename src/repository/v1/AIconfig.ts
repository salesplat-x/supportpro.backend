import AIconfig from "../../models/v1/AIconfig";
import { IAIConfig } from "../../typings/AIconfig";
import { Types } from "mongoose";
import { ScreeningStage, TScreeningStage } from "../../typings/application";

export const createAIconfig = async (config: IAIConfig) => {
  return await new AIconfig(config).save();
};

export const createOrUpdateAIconfig = async (
  recruiter: Types.ObjectId | string,
  config: IAIConfig
) => {
  return await AIconfig.findOneAndUpdate({ recruiter }, config, {
    upsert: true,
    new: true,
  });
};

export const findAndUpdateAIConfigById = async (
  configId: Types.ObjectId | string,
  config: IAIConfig
) => {
  return await AIconfig.findByIdAndUpdate(configId, config, {
    new: true,
  });
};

export const findAIconfigById = async (id: Types.ObjectId | string) => {
  return await AIconfig.findById(id);
};

export const findAIconfigByMatch = async (match: Partial<IAIConfig>) => {
  return await AIconfig.findOne(match);
};

export const findAIconfigsByMatch = async (match: Partial<IAIConfig>) => {
  return await AIconfig.find(match);
};

// Create stages object based on recruiter selections
export const createStages = (config: IAIConfig): Map<TScreeningStage, TScreeningStage> => {
  const stages = new Map<TScreeningStage, TScreeningStage>();
  let currentStage: TScreeningStage = ScreeningStage.Prescreening;

  if (config.cvSimilarity) {
    stages.set(currentStage, ScreeningStage.CvSimilarity);
    currentStage = ScreeningStage.CvSimilarity;
  }
  if (config.personalizedAssessment) {
    stages.set(currentStage, ScreeningStage.Personalized);
    currentStage = ScreeningStage.Personalized;
  }
  if (config.personalityEvaluation) {
    stages.set(currentStage, ScreeningStage.Personality);
    currentStage = ScreeningStage.Personality;
  }
  stages.set(currentStage, ScreeningStage.Completed); // End of process

  return stages;
};
