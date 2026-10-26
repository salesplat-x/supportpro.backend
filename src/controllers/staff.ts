import { Request, Response } from "express";
import { getPeopleAccess } from "../services/peopleAccess.js";
import * as staffService from "../services/staff.js";
import * as staffAudit from "../services/staffAudit.js";
import * as staffInvites from "../services/staffInvite.js";
import { getClientIp } from "../utils/clientIp.js";
import { sendSuccessResponse } from "../utils/response.js";
import type { StaffStatus } from "../entities/StaffMember.js";

const DEFAULT_LIMIT = 25;

const orgId = (req: Request) => req.params["_id"]!;
const staffId = (req: Request) => req.params["staffId"]!;
const queryText = (req: Request, key: string) => req.query[key] as string | undefined;

const paging = (req: Request) => ({
  limit: Number(req.query["limit"] ?? DEFAULT_LIMIT),
  offset: Number(req.query["offset"] ?? 0),
});

export const access = async (req: Request, res: Response) => {
  const result = await getPeopleAccess(req.user.id, orgId(req));
  sendSuccessResponse(res, "Access fetched", { access: result });
};

export const list = async (req: Request, res: Response) => {
  const result = await staffService.listStaff(req.user.id, orgId(req), {
    search: queryText(req, "search"),
    status: queryText(req, "status") as StaffStatus | undefined,
    ...paging(req),
  });
  sendSuccessResponse(res, "Staff fetched", result);
};

export const options = async (req: Request, res: Response) => {
  const result = await staffService.listOptions(
    req.user.id,
    orgId(req),
    Boolean(req.query["includeEnded"])
  );
  sendSuccessResponse(res, "Staff options fetched", { options: result });
};

export const create = async (req: Request, res: Response) => {
  const { fullName, email, jobTitle, department, managerId, startDate, isExecutive, sendInvite } =
    req.body;
  const result = await staffService.createStaff(req.user, orgId(req), {
    fullName,
    email,
    jobTitle,
    department,
    managerId,
    startDate,
    isExecutive,
    sendInvite,
  });
  sendSuccessResponse(res, "Staff member added", result, 201);
};

export const get = async (req: Request, res: Response) => {
  const staff = await staffService.getStaff(req.user, orgId(req), staffId(req), getClientIp(req));
  sendSuccessResponse(res, "Staff member fetched", { staff });
};

export const update = async (req: Request, res: Response) => {
  const { fullName, jobTitle, department, managerId, startDate, isExecutive } = req.body;
  const staff = await staffService.updateStaff(req.user, orgId(req), staffId(req), {
    fullName,
    jobTitle,
    department,
    managerId,
    startDate,
    isExecutive,
  });
  sendSuccessResponse(res, "Staff member updated", { staff });
};

export const end = async (req: Request, res: Response) => {
  const staff = await staffService.endStaff(
    req.user,
    orgId(req),
    staffId(req),
    req.body.endDate as string | undefined
  );
  sendSuccessResponse(res, "Employment ended", { staff });
};

export const invite = async (req: Request, res: Response) => {
  const result = await staffInvites.inviteStaff(req.user, orgId(req), staffId(req));
  sendSuccessResponse(res, "Invite sent", result);
};

export const activity = async (req: Request, res: Response) => {
  const activities = await staffAudit.listActivity(
    req.user,
    orgId(req),
    staffId(req),
    getClientIp(req)
  );
  sendSuccessResponse(res, "Activity fetched", { activities });
};

export const accessLog = async (req: Request, res: Response) => {
  const result = await staffAudit.listAccessLog(req.user.id, orgId(req), {
    staffId: queryText(req, "staffId"),
    actorId: queryText(req, "actorId"),
    from: queryText(req, "from"),
    to: queryText(req, "to"),
    ...paging(req),
  });
  sendSuccessResponse(res, "Access log fetched", result);
};
