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

export const updateLogo = async (req: Request, res: Response) => {
  const result = await organizationService.updateLogo(req.user.id, req.params["_id"]!, req.file);
  sendSuccessResponse(res, "Company logo updated", { organization: result });
};

export const removeLogo = async (req: Request, res: Response) => {
  const result = await organizationService.removeLogo(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "Company logo removed", { organization: result });
};

export const sendOrganizationInvite = async (req: Request, res: Response) => {
  const result = await organizationService.sendOrganizationInvite(
    req.user.id,
    req.params["_id"]!,
    req.body.email
  );
  sendSuccessResponse(res, "Invite sent", { invite: result }, 201);
};

export const listOrganizationMembers = async (req: Request, res: Response) => {
  const result = await organizationService.listOrganizationMembers(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "Members fetched", { members: result });
};

export const listOrganizationInvites = async (req: Request, res: Response) => {
  const result = await organizationService.listOrganizationInvites(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "Invites fetched", { invites: result });
};

export const revokeOrganizationInvite = async (req: Request, res: Response) => {
  await organizationService.revokeOrganizationInvite(
    req.user.id,
    req.params["_id"]!,
    req.params["inviteId"]!
  );
  sendSuccessResponse(res, "Invite revoked", {});
};

export const getOrganizationInvitePreview = async (req: Request, res: Response) => {
  const result = await organizationService.getOrganizationInvitePreview(req.params["token"]!);
  sendSuccessResponse(res, "Invite fetched", { invite: result });
};

export const acceptOrganizationInvite = async (req: Request, res: Response) => {
  const result = await organizationService.acceptOrganizationInvite(
    req.user.id,
    req.params["token"]!
  );
  sendSuccessResponse(res, "You have joined the company", { organization: result });
};
