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

export const listVerifiedOrganizations = async (req: Request, res: Response) => {
  const result = await organizationService.listVerifiedOrganizations(
    req.query["search"] as string | undefined
  );
  sendSuccessResponse(res, "Verified organizations fetched", { organizations: result });
};

export const requestJoinOrganization = async (req: Request, res: Response) => {
  const result = await organizationService.requestJoinOrganization(
    req.user.id,
    req.params["_id"]!,
    req.body.workEmail
  );
  sendSuccessResponse(res, result.message, {});
};

export const listOrganizationJoinRequests = async (req: Request, res: Response) => {
  const result = await organizationService.listOrganizationJoinRequests(
    req.user.id,
    req.params["_id"]!
  );
  sendSuccessResponse(res, "Join requests fetched", { joinRequests: result });
};

export const approveJoinRequest = async (req: Request, res: Response) => {
  const result = await organizationService.approveJoinRequest(
    req.user.id,
    req.params["requestId"]!
  );
  sendSuccessResponse(res, "Recruiter approved and added to company", { organization: result });
};

export const rejectJoinRequest = async (req: Request, res: Response) => {
  await organizationService.rejectJoinRequest(req.user.id, req.params["requestId"]!);
  sendSuccessResponse(res, "Join request rejected", {});
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
