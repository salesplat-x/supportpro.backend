import { EntityManager, Not } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { StaffAccessResource } from "../entities/StaffAccessLog.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { StaffMember, StaffStatus } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import { ConflictError, ValidationError } from "../utils/errors";
import { copyDefaultChecklist } from "./checklist.js";
import { assertCanManagePeople } from "./peopleAccess.js";
import { activityEntry, openStaff, recordActivities } from "./staffAudit.js";
import { assertCanInvite, issueInvite, sendInviteEmail } from "./staffInvite.js";
import {
  StaffView,
  findStaff,
  isUniqueViolation,
  loadManagerNames,
  toStaffView,
  viewOf,
} from "./staffRecord.js";

const DAY_MS = 86_400_000;
const MAX_MANAGER_CHAIN = 100;
const MAX_OPTIONS = 500;

export interface CreateStaffInput {
  fullName: string;
  email: string;
  jobTitle: string;
  department?: string | null;
  managerId?: string | null;
  startDate: string;
  isExecutive?: boolean;
  sendInvite?: boolean;
}

export interface UpdateStaffInput {
  fullName?: string;
  jobTitle?: string;
  department?: string | null;
  managerId?: string | null;
  startDate?: string;
  isExecutive?: boolean;
}

export interface ListStaffQuery {
  search?: string;
  status?: StaffStatus;
  limit: number;
  offset: number;
}

export interface StaffOption {
  id: string;
  fullName: string;
  jobTitle: string;
  status: StaffStatus;
}

type TrackedField = "fullName" | "jobTitle" | "department" | "startDate" | "isExecutive";

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

const tomorrowUtc = (): string => new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, "\\$&");

/** Serialises manager changes in a company so two edits can't each look fine and together form a loop. */
export const lockHierarchy = (em: EntityManager, organizationId: string) =>
  em.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`staff-hierarchy:${organizationId}`]);

/**
 * The manager must be current staff in the same company. The share lock stops
 * them being ended while someone is being assigned to them. When `selfId` is
 * given (an edit, not an add) it also refuses loops in the reporting line.
 */
const assertValidManager = async (
  em: EntityManager,
  organizationId: string,
  managerId: string,
  selfId?: string
): Promise<void> => {
  const manager = await em.getRepository(StaffMember).findOne({
    where: { id: managerId, organizationId },
    lock: { mode: "pessimistic_read" },
  });
  if (!manager || manager.status === StaffStatus.Ended) {
    throw new ValidationError("Choose a manager from your current staff");
  }
  if (!selfId) return;
  if (managerId === selfId) {
    throw new ValidationError("A person can't be their own manager");
  }

  const loops: unknown[] = await em.query(
    `WITH RECURSIVE chain AS (
       SELECT id, manager_id, 1 AS depth FROM staff_members
       WHERE id = $1 AND organization_id = $2
       UNION ALL
       SELECT s.id, s.manager_id, chain.depth + 1 FROM staff_members s
       JOIN chain ON s.id = chain.manager_id
       WHERE s.organization_id = $2 AND chain.depth < $3
     )
     SELECT 1 FROM chain WHERE id = $4 LIMIT 1`,
    [managerId, organizationId, MAX_MANAGER_CHAIN, selfId]
  );
  if (loops.length > 0) {
    throw new ValidationError("That would make the reporting line loop back on itself");
  }
};

export const createStaff = async (
  actor: User,
  organizationId: string,
  input: CreateStaffInput
): Promise<{ staff: StaffView; inviteEmailSent: boolean | null }> => {
  const org = await assertCanManagePeople(actor.id, organizationId);
  const email = input.email.toLowerCase().trim();
  const sendInvite = input.sendInvite === true;
  if (sendInvite) {
    await assertCanInvite(org, email);
  }

  let token: string | null = null;
  let saved: StaffMember;
  try {
    saved = await AppDataSource.transaction(async (em) => {
      if (input.managerId) {
        await assertValidManager(em, organizationId, input.managerId);
      }
      const repo = em.getRepository(StaffMember);
      const record = repo.create({
        organizationId,
        fullName: input.fullName,
        email,
        jobTitle: input.jobTitle,
        department: input.department?.trim() || null,
        managerId: input.managerId ?? null,
        startDate: input.startDate,
        isExecutive: input.isExecutive ?? false,
        status: sendInvite ? StaffStatus.Invited : StaffStatus.Active,
        hiredThroughAuxhr: false,
        createdById: actor.id,
      });
      if (sendInvite) {
        token = issueInvite(record, actor);
      }
      const created = await repo.save(record);
      await copyDefaultChecklist(em, org, created);
      await recordActivities(em, created, [
        activityEntry(StaffActivityType.Created, actor),
        ...(sendInvite ? [activityEntry(StaffActivityType.Invited, actor)] : []),
      ]);
      return created;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("Someone with this email is already on your staff");
    }
    throw err;
  }

  const inviteEmailSent = token ? await sendInviteEmail(org, saved, token, actor) : null;
  return { staff: await viewOf(saved), inviteEmailSent };
};

export const listStaff = async (
  userId: string,
  organizationId: string,
  query: ListStaffQuery
): Promise<{ items: StaffView[]; total: number; counts: Record<StaffStatus, number> }> => {
  await assertCanManagePeople(userId, organizationId);
  const repo = AppDataSource.getRepository(StaffMember);

  const qb = repo
    .createQueryBuilder("staff")
    .where("staff.organizationId = :organizationId", { organizationId });
  if (query.status) {
    qb.andWhere("staff.status = :status", { status: query.status });
  }
  if (query.search) {
    qb.andWhere(
      `(staff.fullName ILIKE :search ESCAPE '\\'
        OR staff.email ILIKE :search ESCAPE '\\'
        OR staff.jobTitle ILIKE :search ESCAPE '\\'
        OR staff.department ILIKE :search ESCAPE '\\')`,
      { search: `%${escapeLike(query.search)}%` }
    );
  }
  const [rows, total] = await qb
    .orderBy("staff.createdAt", "DESC")
    .addOrderBy("staff.id", "ASC")
    .take(query.limit)
    .skip(query.offset)
    .getManyAndCount();

  const grouped = await repo
    .createQueryBuilder("staff")
    .select("staff.status", "status")
    .addSelect("COUNT(*)", "count")
    .where("staff.organizationId = :organizationId", { organizationId })
    .groupBy("staff.status")
    .getRawMany<{ status: StaffStatus; count: string }>();
  const counts: Record<StaffStatus, number> = {
    [StaffStatus.Invited]: 0,
    [StaffStatus.Active]: 0,
    [StaffStatus.Ended]: 0,
  };
  for (const row of grouped) {
    counts[row.status] = Number(row.count);
  }

  const managerNames = await loadManagerNames(rows);
  return { items: rows.map((row) => toStaffView(row, managerNames)), total, counts };
};

/** Light list for pickers: the manager dropdown (current staff) and the access-log filter (everyone). */
export const listOptions = async (
  userId: string,
  organizationId: string,
  includeEnded: boolean
): Promise<StaffOption[]> => {
  await assertCanManagePeople(userId, organizationId);
  return AppDataSource.getRepository(StaffMember).find({
    where: includeEnded ? { organizationId } : { organizationId, status: Not(StaffStatus.Ended) },
    select: { id: true, fullName: true, jobTitle: true, status: true },
    order: { fullName: "ASC" },
    take: MAX_OPTIONS,
  });
};

export const getStaff = async (
  actor: User,
  organizationId: string,
  staffId: string,
  ip: string
): Promise<StaffView> =>
  viewOf(await openStaff(actor, organizationId, staffId, StaffAccessResource.StaffRecord, ip));

export const updateStaff = async (
  actor: User,
  organizationId: string,
  staffId: string,
  input: UpdateStaffInput
): Promise<StaffView> => {
  await assertCanManagePeople(actor.id, organizationId);

  const staff = await AppDataSource.transaction(async (em) => {
    if (input.managerId !== undefined) {
      await lockHierarchy(em, organizationId);
    }
    const current = await findStaff(organizationId, staffId, { em, lock: true });
    if (current.status === StaffStatus.Ended) {
      throw new ConflictError("This employment has ended and can no longer be changed");
    }

    const changes: Record<string, [unknown, unknown]> = {};
    const change = <K extends TrackedField>(field: K, next: StaffMember[K] | undefined) => {
      if (next === undefined || next === current[field]) return;
      changes[field] = [current[field], next];
      current[field] = next;
    };
    change("fullName", input.fullName);
    change("jobTitle", input.jobTitle);
    change(
      "department",
      input.department === undefined ? undefined : input.department?.trim() || null
    );
    change("startDate", input.startDate);
    change("isExecutive", input.isExecutive);

    if (input.managerId !== undefined && input.managerId !== current.managerId) {
      if (input.managerId) {
        await assertValidManager(em, organizationId, input.managerId, current.id);
      }
      const names = await loadManagerNames(
        [{ managerId: current.managerId }, { managerId: input.managerId }],
        em
      );
      changes["manager"] = [
        current.managerId ? (names.get(current.managerId) ?? null) : null,
        input.managerId ? (names.get(input.managerId) ?? null) : null,
      ];
      current.managerId = input.managerId;
    }

    if (Object.keys(changes).length === 0) {
      return current;
    }
    const saved = await em.getRepository(StaffMember).save(current);
    await recordActivities(em, saved, [
      activityEntry(StaffActivityType.Updated, actor, { changes }),
    ]);
    return saved;
  });

  return viewOf(staff);
};

export const endStaff = async (
  actor: User,
  organizationId: string,
  staffId: string,
  endDate?: string
): Promise<StaffView> => {
  await assertCanManagePeople(actor.id, organizationId);

  const staff = await AppDataSource.transaction(async (em) => {
    const current = await findStaff(organizationId, staffId, { em, lock: true });
    if (current.status === StaffStatus.Ended) {
      throw new ConflictError("This employment has already ended");
    }
    const effective = endDate ?? todayUtc();
    if (effective < current.startDate) {
      throw new ValidationError("The end date can't be before the start date");
    }
    if (effective > tomorrowUtc()) {
      throw new ValidationError("The end date can't be in the future");
    }

    current.status = StaffStatus.Ended;
    current.endDate = effective;
    current.inviteTokenHash = null;
    current.inviteExpiresAt = null;
    const saved = await em.getRepository(StaffMember).save(current);
    await recordActivities(em, saved, [
      activityEntry(StaffActivityType.Ended, actor, { endDate: effective }),
    ]);
    return saved;
  });

  return viewOf(staff);
};
