import { IUser } from "../../typings/user";
import * as aiConfigRepository from "../../repository/v1/AIconfig";
import { IAIConfig } from "../../typings/AIconfig";
import { makeResponse } from "../../helpers/response";
import { Roles } from "../../typings/customs";

export const createAIConfig = async (user: IUser, payload: IAIConfig) => {
  payload.recruiter = user._id;

  const existing = await aiConfigRepository.findAIconfigByMatch({
    recruiter: user._id,
    name: payload.name.toLowerCase(),
  });
  if (existing) {
    return makeResponse(false, "Configuration already existing with this name");
  }

  // Set application stages
  payload.stages = aiConfigRepository.createStages(payload);
  const config = await aiConfigRepository.createAIconfig({
    ...payload,
    recruiter: user._id,
  });
  return makeResponse(true, "AI configuration created", { config });
};

export const updateAIConfig = async (user: IUser, payload: IAIConfig) => {
  let config = await aiConfigRepository.findAIconfigById(payload._id!);

  if (!config) {
    return makeResponse(false, "Configuration not found", {}, 403);
  }

  if (
    config.recruiter?.toString() != user._id.toString() &&
    user.userRole !== Roles.Admin
  ) {
    return makeResponse(
      false,
      "You are not authorized to perform this action",
      {},
      403
    );
  }

  if (payload.name) {
    const existing = await aiConfigRepository.findAIconfigByMatch({
      recruiter: user._id,
      name: payload.name.toLowerCase(),
    });
    if (existing && existing.id !== config.id) {
      return makeResponse(
        false,
        "Your already have a configuration with this name"
      );
    }
  }

  // Set application stages

  payload.stages = aiConfigRepository.createStages(payload);

  config = await aiConfigRepository.findAndUpdateAIConfigById(
    config._id,
    payload
  );
  return makeResponse(true, "AI configuration updated", { config });
};

export const allAIConfig = async (user: IUser) => {
  const config = await aiConfigRepository.findAIconfigsByMatch({
    recruiter: user._id,
  });
  return makeResponse(true, "AI configuration set", { config });
};

export const fetchAIConfig = async (
  user: IUser,
  payload: Pick<IAIConfig, "_id">
) => {
  const config = await aiConfigRepository.findAIconfigById(payload._id!);

  if (!config) {
    return makeResponse(false, "Configuration not found", {}, 403);
  }

  if (config.recruiter?.toString() != user._id.toString()) {
    return makeResponse(
      false,
      "You are not authorized to perform this action",
      {},
      403
    );
  }
  return makeResponse(true, "AI configuration set", { config });
};

export const deleteAIConfig = async (
  user: IUser,
  payload: Pick<IAIConfig, "_id">
) => {
  const config = await aiConfigRepository.findAIconfigById(payload._id!);

  if (!config) {
    return makeResponse(false, "Configuration not found", {}, 403);
  }

  if (config.recruiter?.toString() != user._id.toString()) {
    return makeResponse(
      false,
      "You are not authorized to perform this action",
      {},
      403
    );
  }

  await config.deleteOne();

  return makeResponse(true, "AI configuration deleted", {});
};
