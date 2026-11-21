import { Request, Response } from "express";
import type { EndReason } from "../entities/StaffMember.js";
import * as hrAssignmentsService from "../services/hrAssignments.js";
import type { TaskOwner } from "../entities/StaffChecklistTask.js";
import * as checklist from "../services/checklist.js";
import { getOrgChart } from "../services/orgChart.js";
import * as companyProfile from "../services/companyProfile.js";
import { getPeopleAccess, requestPeopleAccess } from "../services/peopleAccess.js";
import * as staffService from "../services/staff.js";
import * as staffAudit from "../services/staffAudit.js";
import * as staffImport from "../services/staffImport.js";
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

export const requestAccess = async (req: Request, res: Response) => {
  await requestPeopleAccess(req.user, orgId(req));
  sendSuccessResponse(res, "Access requested", undefined, 201);
};

export const list = async (req: Request, res: Response) => {
  const result = await staffService.listStaff(req.user.id, orgId(req), {
    search: queryText(req, "search"),
    status: queryText(req, "status") as StaffStatus | undefined,
    assignedToMe: req.query["assignedToMe"] === "true",
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
  const {
    fullName,
    email,
    jobTitle,
    department,
    managerId,
    startDate,
    isExecutive,
    phone,
    homeAddress,
    sendInvite,
    applicationId,
  } = req.body;
  const result = await staffService.createStaff(req.user, orgId(req), {
    fullName,
    email,
    jobTitle,
    department,
    managerId,
    startDate,
    isExecutive,
    phone,
    homeAddress,
    sendInvite,
    applicationId,
  });
  sendSuccessResponse(res, "Staff member added", result, 201);
};

export const get = async (req: Request, res: Response) => {
  const staff = await staffService.getStaff(req.user, orgId(req), staffId(req), getClientIp(req));
  sendSuccessResponse(res, "Staff member fetched", { staff });
};

export const update = async (req: Request, res: Response) => {
  const {
    fullName,
    email,
    jobTitle,
    department,
    managerId,
    startDate,
    isExecutive,
    phone,
    homeAddress,
  } = req.body;
  const staff = await staffService.updateStaff(req.user, orgId(req), staffId(req), {
    fullName,
    email,
    phone,
    homeAddress,
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
    req.body.endDate as string | undefined,
    req.body.reason as EndReason | null | undefined
  );
  sendSuccessResponse(res, staff.endingOn ? "End date saved" : "Employment ended", { staff });
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
    resource: queryText(req, "resource"),
    from: queryText(req, "from"),
    to: queryText(req, "to"),
    ...paging(req),
  });
  sendSuccessResponse(res, "Access log fetched", result);
};

export const importStaff = async (req: Request, res: Response) => {
  const rows = req.body.rows as unknown[];
  if (req.body.commit === true) {
    const result = await staffImport.commitImport(req.user, orgId(req), rows);
    sendSuccessResponse(res, "Staff imported", result);
    return;
  }
  const preview = await staffImport.previewImport(req.user, orgId(req), rows);
  sendSuccessResponse(res, "Import checked", preview);
};

export const exportStaff = async (req: Request, res: Response) => {
  const staff = await staffImport.exportStaff(req.user.id, orgId(req));
  sendSuccessResponse(res, "Staff exported", { staff });
};

export const checklistDefaults = async (req: Request, res: Response) => {
  const items = await checklist.getChecklistDefaults(req.user.id, orgId(req));
  sendSuccessResponse(res, "Default checklist fetched", { items });
};

export const saveChecklistDefaults = async (req: Request, res: Response) => {
  const items = await checklist.setChecklistDefaults(
    req.user.id,
    orgId(req),
    (req.body.items as checklist.ChecklistItem[]).map(
      ({ title, dueInDays, description, owner }) => ({
        title,
        dueInDays,
        description: description?.trim() || null,
        owner: owner ?? null,
      })
    )
  );
  sendSuccessResponse(res, "Default checklist saved", { items });
};

export const tasks = async (req: Request, res: Response) => {
  const list = await checklist.listTasks(req.user, orgId(req), staffId(req));
  sendSuccessResponse(res, "Checklist fetched", { tasks: list });
};

export const addTask = async (req: Request, res: Response) => {
  const task = await checklist.addTask(req.user, orgId(req), staffId(req), {
    title: req.body.title as string,
    dueOn: (req.body.dueOn as string | undefined) ?? null,
    description: (req.body.description as string | undefined)?.trim() || null,
    owner: (req.body.owner as TaskOwner | undefined) ?? null,
  });
  sendSuccessResponse(res, "Task added", { task }, 201);
};

export const deleteTask = async (req: Request, res: Response) => {
  await checklist.deleteTask(req.user, orgId(req), staffId(req), req.params["taskId"]!);
  sendSuccessResponse(res, "Task removed");
};

export const getCompanyProfile = async (req: Request, res: Response) => {
  const profile = await companyProfile.getCompanyProfile(req.user.id, orgId(req));
  sendSuccessResponse(res, "Company profile fetched", { profile });
};

export const saveCompanyProfile = async (req: Request, res: Response) => {
  const { mission, vision, yearlyGoals } = req.body;
  const profile = await companyProfile.saveCompanyProfile(req.user.id, orgId(req), {
    mission: (mission as string | null | undefined) || null,
    vision: (vision as string | null | undefined) || null,
    yearlyGoals: yearlyGoals as string[],
  });
  sendSuccessResponse(res, "Company profile saved", { profile });
};

export const fillCompanyProfile = async (req: Request, res: Response) => {
  const profile = await companyProfile.fillCompanyProfileFromDocument(
    req.user.id,
    orgId(req),
    req.file
  );
  sendSuccessResponse(res, "Company profile filled in", { profile });
};

export const orgChart = async (req: Request, res: Response) => {
  sendSuccessResponse(res, "Org chart fetched", await getOrgChart(req.user.id, orgId(req)));
};

export const hrAssignees = async (req: Request, res: Response) => {
  const assignees = await hrAssignmentsService.listHrAssignees(
    req.user,
    orgId(req),
    req.params["staffId"]!
  );
  sendSuccessResponse(res, "Assigned HR fetched", { assignees });
};

export const assignedStaff = async (req: Request, res: Response) => {
  const assignedStaffIds = await hrAssignmentsService.listAssignedStaffIds(
    req.user,
    orgId(req),
    queryText(req, "assigneeUserId")!
  );
  sendSuccessResponse(res, "Assigned people fetched", { assignedStaffIds });
};

export const setHrAssignments = async (req: Request, res: Response) => {
  const { assigneeUserId, add, remove } = req.body as {
    assigneeUserId: string;
    add?: string[];
    remove?: string[];
  };
  const result = await hrAssignmentsService.setHrAssignments(req.user, orgId(req), {
    assigneeUserId,
    add: add ?? [],
    remove: remove ?? [],
  });
  sendSuccessResponse(res, "Assigned people saved", result);
};
