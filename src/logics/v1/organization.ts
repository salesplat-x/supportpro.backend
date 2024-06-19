import { IUser } from "../../typings/user";
import * as aiConfigRepository from "../../repository/v1/AIconfig";
import { IAIConfig } from "../../typings/AIconfig";
import { makeResponse } from "../../helpers/response";

export const setAIConfig = async (admin: IUser, payload: IAIConfig) => {
  payload.recruiter = admin._id;
  const config = await aiConfigRepository.createOrUpdateAIconfig(
    admin._id,
    payload
  );
  return makeResponse(true, "AI configuration set", { config });
};

export const getAIConfig = async (admin: IUser) => {
  const config = await aiConfigRepository.findAIconfigByMatch({
    recruiter: admin._id,
  });
  return makeResponse(true, "AI configuration set", { config });
};
