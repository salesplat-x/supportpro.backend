import { Request, Response } from "express";
import * as organizationService from "../services/organization.js";
import { sendSuccessResponse } from "../utils/response.js";

export const registerOrganization = async (req: Request, res: Response) => {
  const result = await organizationService.createOrganization(req.body);
  sendSuccessResponse(res, "Organization registered", { organization: result }, 201);
};
