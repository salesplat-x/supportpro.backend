import type { Request, Response } from "express";
import { Not } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ApplicationReference } from "../entities/ApplicationReference.js";
import { CompanyActivity } from "../entities/CompanyActivity.js";
import { Job } from "../entities/Job.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { StaffMember, StaffStatus } from "../entities/StaffMember.js";
import { User } from "../entities/User.js";
import { getClientIp } from "../utils/clientIp.js";
import logger from "../utils/logger.js";
import { assertOwner } from "./peopleAccess.js";
import { fullNameOf } from "./staffRecord.js";

export const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Personal, platform or public routes: what someone does there isn't a company change. */
const SKIPPED_PREFIXES = [
  "/v1/auth",
  "/v1/user",
  "/v1/notifications",
  "/v1/feedback",
  "/v1/email-preferences",
  "/v1/admin",
  "/v1/error-logs",
  "/v1/staff-invites",
  "/v1/references/respond",
];

const MAX_CHANGED_FIELDS = 30;
const MAX_FIELD_NAME = 64;
const MAX_ACTIVITY_PAGE = 100;
const MY_WORK_PREFIX = "/v1/my-work";

export interface ActivityTarget {
  type: string;
  id: string | null;
  label: string | null;
}

export interface CompanyActivityView {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actorName: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  changedFields: string[];
  ip: string | null;
}

export interface CompanyActivityQuery {
  actorId?: string;
  search?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

/** Names the item a change was made to, so the log reads "updated job · Sales Lead". */
export const noteActivityTarget = (
  res: Response,
  type: string,
  id: string | null,
  label?: string | null
): void => {
  res.locals["activityTarget"] = {
    type,
    id,
    label: label ? label.slice(0, 241) : null,
  } satisfies ActivityTarget;
};

/** For a change that belongs to a company the route can't name, such as creating one. */
export const noteActivityOrganization = (res: Response, organizationId: string): void => {
  res.locals["activityOrganizationId"] = organizationId;
};

const fullName = (person: Pick<User, "firstName" | "lastName"> | null | undefined) =>
  person ? fullNameOf(person) : null;

/** Names the item a route acts on from its ids, so every route gets a readable row. */
export const lookupActivityTarget = async (
  route: string,
  params: Record<string, string>
): Promise<ActivityTarget | null> => {
  const { applicationId, referenceId, staffId, memberId } = params;
  const jobId = params["jobId"] ?? (route.startsWith("/v1/jobs") ? params["_id"] : undefined);
  if (isUuid(applicationId)) {
    const application = await AppDataSource.getRepository(Application).findOne({
      where: { id: applicationId },
      relations: { talent: true, job: { role: true } },
    });
    const parts = [fullName(application?.talent), application?.job?.role?.name].filter(Boolean);
    return { type: "application", id: applicationId, label: parts.join(" · ") || null };
  }
  if (isUuid(referenceId)) {
    const reference = await AppDataSource.getRepository(ApplicationReference).findOne({
      where: { id: referenceId },
      select: { id: true, name: true },
    });
    return { type: "referee", id: referenceId, label: reference?.name ?? null };
  }
  if (isUuid(staffId)) {
    const staff = await AppDataSource.getRepository(StaffMember).findOne({
      where: { id: staffId },
      select: { id: true, fullName: true },
    });
    return { type: "staff", id: staffId, label: staff?.fullName ?? null };
  }
  if (isUuid(memberId)) {
    const member = await AppDataSource.getRepository(OrganizationMember).findOne({
      where: { id: memberId },
      relations: { user: true },
    });
    return { type: "member", id: memberId, label: fullName(member?.user) };
  }
  if (isUuid(jobId)) {
    const job = await AppDataSource.getRepository(Job).findOne({
      where: { id: jobId },
      relations: { role: true },
    });
    return { type: "job", id: jobId, label: job?.role?.name ?? null };
  }
  return null;
};

const pending = new Set<Promise<void>>();

/** Waits for log rows still being written; tests use it before reading the log. */
export const settleActivityWrites = async (): Promise<void> => {
  await Promise.all([...pending]);
};

const changedFieldsOf = (body: unknown): string[] => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body)
    .filter((key) => key.length <= MAX_FIELD_NAME)
    .slice(0, MAX_CHANGED_FIELDS);
};

const resolveOrganizationId = async (
  user: User,
  route: string,
  params: Record<string, string>,
  noted: unknown
): Promise<string | null> => {
  if (isUuid(noted)) return noted;
  if (route.startsWith("/v1/organizations/") && isUuid(params["_id"])) return params["_id"];
  if (isUuid(params["staffId"])) {
    const staff = await AppDataSource.getRepository(StaffMember).findOne({
      where: { id: params["staffId"] },
      select: { id: true, organizationId: true },
    });
    if (staff) return staff.organizationId;
  }
  const fresh = await AppDataSource.getRepository(User).findOne({
    where: { id: user.id },
    select: { id: true, activeOrganizationId: true },
  });
  if (fresh?.activeOrganizationId) return fresh.activeOrganizationId;
  if (!route.startsWith(MY_WORK_PREFIX)) return null;
  const staffRecords = await AppDataSource.getRepository(StaffMember).find({
    where: { userId: user.id, status: Not(StaffStatus.Ended) },
    select: { id: true, organizationId: true },
    take: 2,
  });
  return staffRecords.length === 1 ? staffRecords[0]!.organizationId : null;
};

const belongsTo = async (userId: string, organizationId: string): Promise<boolean> => {
  const organization = await AppDataSource.getRepository(Organization).findOne({
    where: { id: organizationId },
    select: { id: true, ownerId: true },
  });
  if (!organization) return false;
  if (organization.ownerId === userId) return true;
  if (
    await AppDataSource.getRepository(OrganizationMember).exists({
      where: { userId, organizationId },
    })
  ) {
    return true;
  }
  return AppDataSource.getRepository(StaffMember).exists({
    where: { userId, organizationId, status: Not(StaffStatus.Ended) },
  });
};

const record = async (req: Request, res: Response): Promise<void> => {
  const action = res.locals["action"] as string | undefined;
  const route = res.locals["route"] as string | undefined;
  if (res.statusCode >= 400 || !req.user?.id || !action || !route) return;
  if (SKIPPED_PREFIXES.some((prefix) => route.startsWith(prefix))) return;

  const params = (res.locals["routeParams"] as Record<string, string> | undefined) ?? {};
  const organizationId = await resolveOrganizationId(
    req.user,
    route,
    params,
    res.locals["activityOrganizationId"]
  );
  if (!organizationId || !(await belongsTo(req.user.id, organizationId))) return;

  const noted =
    (res.locals["activityTarget"] as ActivityTarget | undefined) ??
    (await lookupActivityTarget(route, params)) ??
    undefined;
  const fallbackId = Object.values(params).find(isUuid) ?? null;
  await AppDataSource.getRepository(CompanyActivity).insert({
    organizationId,
    actorId: req.user.id,
    actorName: fullNameOf(req.user),
    action: action.slice(0, 120),
    method: req.method,
    route: route.slice(0, 255),
    targetType: noted?.type ?? null,
    targetId: noted ? noted.id : fallbackId,
    targetLabel: noted?.label ?? null,
    changedFields: changedFieldsOf(req.body),
    ip: getClientIp(req) || null,
    createdAt: new Date(),
  });
};

/**
 * Runs once the response has gone out, so a failed write is logged and never
 * changes what the person saw.
 */
export const recordCompanyActivity = (req: Request, res: Response): void => {
  const write = record(req, res).catch((error: unknown) => {
    logger.warn(`Company activity for ${req.method} ${req.originalUrl} failed: ${String(error)}`);
  });
  pending.add(write);
  void write.finally(() => pending.delete(write));
};

export const listCompanyActivity = async (
  userId: string,
  organizationId: string,
  query: CompanyActivityQuery
): Promise<{ items: CompanyActivityView[]; total: number }> => {
  await assertOwner(userId, organizationId);

  const qb = AppDataSource.getRepository(CompanyActivity)
    .createQueryBuilder("activity")
    .where("activity.organizationId = :organizationId", { organizationId });
  if (query.actorId) {
    qb.andWhere("activity.actorId = :actorId", { actorId: query.actorId });
  }
  if (query.search) {
    qb.andWhere(
      "(activity.action ILIKE :search OR activity.targetLabel ILIKE :search OR activity.actorName ILIKE :search)",
      { search: `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%` }
    );
  }
  if (query.from) {
    qb.andWhere("activity.createdAt >= CAST(:from AS date)", { from: query.from });
  }
  if (query.to) {
    qb.andWhere("activity.createdAt < CAST(:to AS date) + INTERVAL '1 day'", { to: query.to });
  }
  const [rows, total] = await qb
    .orderBy("activity.createdAt", "DESC")
    .addOrderBy("activity.id", "ASC")
    .take(Math.min(query.limit, MAX_ACTIVITY_PAGE))
    .skip(query.offset)
    .getManyAndCount();

  return {
    items: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      actorId: row.actorId,
      actorName: row.actorName,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      targetLabel: row.targetLabel,
      changedFields: row.changedFields,
      ip: row.ip,
    })),
    total,
  };
};
