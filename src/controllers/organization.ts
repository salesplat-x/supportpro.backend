import { Request, Response } from "express";
import * as organizationService from "../services/organization.js";
import { sendSuccessResponse } from "../utils/response.js";

export const registerOrganization = async (req: Request, res: Response) => {
  const result = await organizationService.createOrganization(req.user.id, req.body);
  sendSuccessResponse(res, "Organization registered", { organization: result }, 201);
};

export const listMyOrganizations = async (req: Request, res: Response) => {
  const result = await organizationService.listMyOrganizations(req.user.id);
  sendSuccessResponse(res, "Organizations fetched", { organizations: result });
};

export const switchOrganization = async (req: Request, res: Response) => {
  const result = await organizationService.switchOrganization(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "Active company switched", { organization: result });
};

export const updateOrganization = async (req: Request, res: Response) => {
  const result = await organizationService.updateOrganization(
    req.user.id,
    req.params["_id"]!,
    req.body
  );
  sendSuccessResponse(res, "Company updated", { organization: result });
};

export const deleteOrganization = async (req: Request, res: Response) => {
  await organizationService.deleteOrganization(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "Company deleted", {});
};
