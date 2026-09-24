import { Request, Response } from "express";
import * as entitlements from "../services/entitlements.js";
import { sendSuccessResponse } from "../utils/response.js";
import { AuthorizationError, NotFoundError, ValidationError } from "../utils/errors";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";

const assertOrgMember = async (userId: string, organizationId: string): Promise<void> => {
  const org = await AppDataSource.getRepository(Organization).findOne({
    where: { id: organizationId },
  });
  if (!org) throw new NotFoundError("Organization not found");
  if (org.ownerId === userId) return;
  const member = await AppDataSource.getRepository(OrganizationMember).findOne({
    where: { userId, organizationId },
  });
  if (!member) {
    throw new AuthorizationError("You are not a member of this company");
  }
};

export const getOrganizationUsage = async (req: Request, res: Response) => {
  const organizationId = req.params["_id"];
  if (!organizationId) {
    throw new ValidationError("Organization id is required");
  }
  await assertOrgMember(req.user.id, organizationId);
  const usage = await entitlements.getOrganizationUsage(organizationId);
  sendSuccessResponse(res, "Usage fetched", { usage });
};
