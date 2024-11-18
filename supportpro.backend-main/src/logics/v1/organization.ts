import * as orgRepository from "../../repository/v1/organization";
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
