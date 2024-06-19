import { IUser } from "../../typings/user";
import * as aiConfigRepository from "../../repository/v1/AIconfig";
import * as orgRepository from "../../repository/v1/organization";
import { IAIConfig } from "../../typings/AIconfig";
import { makeResponse } from "../../helpers/response";
import { validateEmail } from "../../helpers/func";
import { IOrganization } from "../../typings/organization";

export const createOrganization = async (payload: IOrganization) => {
  let { email, phone } = payload;

  if (!validateEmail(email)) {
    return makeResponse(false, "Invalid Email Address");
  }
  email = email!.toLowerCase();

  let exists = await orgRepository.findOrganizationByEmail(email);
  if (exists) {
    return makeResponse(
      false,
      "Organization already registered with this email"
    );
  }

  exists = await orgRepository.findOrganizationByMatch({ phone });
  if (exists) {
    return makeResponse(
      false,
      "Organization already registered with this phone number"
    );
  }

  const organization = await orgRepository.createOrganization(payload);
  if (!organization) {
    return makeResponse(
      false,
      "Organization registration Failed, Please Try Again"
    );
  }

  return makeResponse(
    true,
    "Organization registered Successfully",
    { organization },
    201
  );
};

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
