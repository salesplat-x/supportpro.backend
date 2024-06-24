import AIconfig from "../../models/v1/AIconfig";
import { IAIConfig } from "../../typings/AIconfig";
import { Types } from "mongoose";

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

export const updateAIconfig = async (
  recruiter: Types.ObjectId | string,
  config: IAIConfig
) => {
  return await AIconfig.findOneAndUpdate({ recruiter }, config, {
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
