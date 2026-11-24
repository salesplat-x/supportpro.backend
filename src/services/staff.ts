import { EntityManager, Not } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { StaffAccessResource } from "../entities/StaffAccessLog.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { StaffHrAssignment } from "../entities/StaffHrAssignment.js";
import { EndReason, StaffMember, StaffStatus } from "../entities/StaffMember.js";
import { resultRows } from "../utils/durableJobs.js";
import type { User } from "../entities/User.js";
import { ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import { ApplicationStatus } from "../types/enums.js";
import { copyDefaultChecklist } from "./checklist.js";
import { withdrawPendingForStaff } from "./completionRequests.js";
import { resolveDepartment } from "./departments.js";
import { assertCanManagePeople, seesOnlyAssignedStaff } from "./peopleAccess.js";
import { activityEntry, openStaff, recordActivities } from "./staffAudit.js";
import {
  assertCanInvite,
  issueInvite,
  sendInviteEmail,
  notifyInvitedTalent,
} from "./staffInvite.js";
import {
  StaffView,
  findStaff,
  isUniqueViolation,
  loadManagerNames,
  toStaffView,
  viewOf,
} from "./staffRecord.js";

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
  phone?: string | null;
  homeAddress?: string | null;
  sendInvite?: boolean;
  applicationId?: string;
}

export interface UpdateStaffInput {
  fullName?: string;
  email?: string;
  phone?: string | null;
  homeAddress?: string | null;
  jobTitle?: string;
  department?: string | null;
  managerId?: string | null;
  startDate?: string;
  isExecutive?: boolean;
}

export interface ListStaffQuery {
  search?: string;
  status?: StaffStatus;
  assignedToMe?: boolean;
  limit: number;
  offset: number;
}

export interface StaffOption {
  id: string;
  fullName: string;
  jobTitle: string;
  status: StaffStatus;
}

type TrackedField =
  | "fullName"
  | "email"
  | "jobTitle"
  | "department"
  | "startDate"
  | "isExecutive"
  | "phone"
  | "homeAddress";

const clearable = (value: string | null | undefined): string | null | undefined =>
  value === undefined ? undefined : value?.trim() || null;

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

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

const shortlistedHire = async (organizationId: string, applicationId: string) => {
  const application = await AppDataSource.getRepository(Application).findOne({
    where: { id: applicationId },
    relations: { job: true, talent: true },
  });
  if (!application || application.job?.organizationId !== organizationId) {
    throw new NotFoundError("Application not found");
  }
  if (application.status !== ApplicationStatus.Shortlisted) {
    throw new ConflictError("Only shortlisted applicants can be added as employees");
  }
  const fullName = `${application.talent.firstName} ${application.talent.lastName}`.trim();
  return { applicationId: application.id, fullName, email: application.talent.email };
};

export const createStaff = async (
  actor: User,
  organizationId: string,
  input: CreateStaffInput
): Promise<{ staff: StaffView; inviteEmailSent: boolean | null }> => {
  const org = await assertCanManagePeople(actor.id, organizationId);
  const hire = input.applicationId
    ? await shortlistedHire(organizationId, input.applicationId)
    : null;
  const fullName = hire?.fullName ?? input.fullName;
  const email = (hire?.email ?? input.email).toLowerCase().trim();
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
      const department = await resolveDepartment(em, organizationId, input.department);
      const repo = em.getRepository(StaffMember);
      const record = repo.create({
        organizationId,
        fullName,
        email,
        jobTitle: input.jobTitle,
        department: department?.name ?? null,
        departmentId: department?.id ?? null,
        managerId: input.managerId ?? null,
        startDate: input.startDate,
        isExecutive: input.isExecutive ?? false,
        phone: clearable(input.phone) ?? null,
        homeAddress: clearable(input.homeAddress) ?? null,
        status: sendInvite ? StaffStatus.Invited : StaffStatus.Active,
        hiredThroughAuxhr: hire !== null,
        sourceApplicationId: hire?.applicationId ?? null,
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
      throw new ConflictError(
        hire
          ? "This applicant is already on your staff"
          : "Someone with this email is already on your staff"
      );
    }
    throw err;
  }

  const inviteEmailSent = token ? await sendInviteEmail(org, saved, token, actor) : null;
  if (token) await notifyInvitedTalent(org, saved);
  return { staff: await viewOf(saved), inviteEmailSent };
};

export const listStaff = async (
  userId: string,
  organizationId: string,
  query: ListStaffQuery
): Promise<{
  items: StaffView[];
  total: number;
  counts: Record<StaffStatus, number>;
  hiredThroughAuxhr: number;
}> => {
  const assignedOnly = await seesOnlyAssignedStaff(userId, organizationId);
  const repo = AppDataSource.getRepository(StaffMember);

  const scoped = () => {
    const scope = repo
      .createQueryBuilder("staff")
      .where("staff.organizationId = :organizationId", { organizationId });
    if (assignedOnly || query.assignedToMe) {
      scope.innerJoin(
        StaffHrAssignment,
        "assignment",
        "assignment.staffId = staff.id AND assignment.assigneeUserId = :userId",
        { userId }
      );
    }
    return assignedOnly ? scope.andWhere("staff.endDate IS NULL") : scope;
  };

  const qb = scoped();
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

  const grouped = await scoped()
    .select("staff.status", "status")
    .addSelect("COUNT(*)", "count")
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

  const hiredThroughAuxhr = await scoped().andWhere("staff.hiredThroughAuxhr = true").getCount();

  const managerNames = await loadManagerNames(rows);
  return {
    items: rows.map((row) => toStaffView(row, managerNames)),
    total,
    counts,
    hiredThroughAuxhr,
  };
};

/** Light list for pickers: the manager dropdown (current staff) and the access-log filter (everyone). */
export const listOptions = async (
  userId: string,
  organizationId: string,
  includeEnded: boolean
): Promise<StaffOption[]> => {
  const assignedOnly = await seesOnlyAssignedStaff(userId, organizationId);
  const repo = AppDataSource.getRepository(StaffMember);
  const qb = repo
    .createQueryBuilder("staff")
    .select(["staff.id", "staff.fullName", "staff.jobTitle", "staff.status"])
    .where("staff.organizationId = :organizationId", { organizationId });
  if (assignedOnly) {
    qb.innerJoin(
      StaffHrAssignment,
      "assignment",
      "assignment.staffId = staff.id AND assignment.assigneeUserId = :userId",
      { userId }
    ).andWhere("staff.endDate IS NULL");
  } else if (!includeEnded) {
    qb.andWhere("staff.status <> :ended", { ended: StaffStatus.Ended });
  }
  return qb.orderBy("staff.fullName", "ASC").take(MAX_OPTIONS).getMany();
};

export const getStaff = async (
  actor: User,
  organizationId: string,
  staffId: string,
  ip: string
): Promise<StaffView> =>
  viewOf(await openStaff(actor, organizationId, staffId, StaffAccessResource.StaffRecord, ip));

const saveOrConflict = async <T>(save: () => Promise<T>): Promise<T> => {
  try {
    return await save();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("Someone with this email is already on your staff");
    }
    throw err;
  }
};

export const updateStaff = async (
  actor: User,
  organizationId: string,
  staffId: string,
  input: UpdateStaffInput
): Promise<StaffView> => {
  await assertCanManagePeople(actor.id, organizationId);

  const staff = await saveOrConflict(() =>
    AppDataSource.transaction(async (em) => {
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
      let relinked = false;
      if (input.department !== undefined) {
        const department = await resolveDepartment(em, organizationId, input.department);
        change("department", department?.name ?? null);
        relinked = (department?.id ?? null) !== current.departmentId;
        current.departmentId = department?.id ?? null;
      }
      change("startDate", input.startDate);
      change("isExecutive", input.isExecutive);
      change("phone", clearable(input.phone));
      change("homeAddress", clearable(input.homeAddress));

      const email = input.email?.toLowerCase().trim();
      if (email !== undefined && email !== current.email) {
        if (current.userId) {
          throw new ConflictError(
            "This person has joined with their own account, so their email can't be changed"
          );
        }
        change("email", email);
        current.inviteTokenHash = null;
        current.inviteExpiresAt = null;
        current.inviteOpenedAt = null;
        current.invitedAt = null;
      }

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

      if (Object.keys(changes).length === 0 && !relinked) {
        return current;
      }
      const saved = await em.getRepository(StaffMember).save(current);
      if (Object.keys(changes).length > 0) {
        await recordActivities(em, saved, [
          activityEntry(StaffActivityType.Updated, actor, { changes }),
        ]);
      }
      return saved;
    })
  );

  return viewOf(staff);
};

const oneYearFromTodayUtc = (): string => {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString().slice(0, 10);
};

/** A date up to today ends the employment now; a later one keeps the person active until that day has passed. */
export const endStaff = async (
  actor: User,
  organizationId: string,
  staffId: string,
  endDate?: string,
  reason?: EndReason | null
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
    if (effective > oneYearFromTodayUtc()) {
      throw new ValidationError("The end date can't be more than a year away");
    }

    current.endReason = reason ?? null;
    const repo = em.getRepository(StaffMember);

    if (effective > todayUtc()) {
      const previous = current.endingOn;
      current.endingOn = effective;
      const saved = await repo.save(current);
      await recordActivities(em, saved, [
        activityEntry(StaffActivityType.EndScheduled, actor, {
          endDate: effective,
          ...(previous ? { previousEndDate: previous } : {}),
          ...(reason ? { reason } : {}),
        }),
      ]);
      return saved;
    }

    current.status = StaffStatus.Ended;
    current.endDate = effective;
    current.endingOn = null;
    await withdrawPendingForStaff(em, current.id);
    current.inviteTokenHash = null;
    current.inviteExpiresAt = null;
    const saved = await repo.save(current);
    await recordActivities(em, saved, [
      activityEntry(StaffActivityType.Ended, actor, {
        endDate: effective,
        ...(reason ? { reason } : {}),
      }),
    ]);
    return saved;
  });

  return viewOf(staff);
};

const FINALIZE_ENDINGS_SQL = `
  UPDATE "staff_members"
  SET "status" = 'ended',
      "end_date" = "ending_on",
      "ending_on" = NULL,
      "invite_token_hash" = NULL,
      "invite_expires_at" = NULL
  WHERE "id" IN (
    SELECT "id" FROM "staff_members"
    WHERE "status" <> 'ended' AND "ending_on" < CURRENT_DATE
    ORDER BY "ending_on"
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING "id", "organization_id", "end_date"
`;

const FINALIZE_BATCH = 200;

/** Ends every employment whose last working day has passed. Safe to run from two containers at once. */
export const finalizeScheduledEndings = async (): Promise<number> => {
  let total = 0;
  for (;;) {
    const ended = await AppDataSource.transaction(async (em) => {
      const rows = resultRows(await em.query(FINALIZE_ENDINGS_SQL, [FINALIZE_BATCH])) as {
        id: string;
        organization_id: string;
        end_date: string;
      }[];
      for (const row of rows) {
        await withdrawPendingForStaff(em, row.id);
        await recordActivities(em, { id: row.id, organizationId: row.organization_id }, [
          {
            type: StaffActivityType.Ended,
            actorId: null,
            actorName: "AuxHR",
            meta: { endDate: row.end_date, scheduled: true },
          },
        ]);
      }
      return rows.length;
    });
    total += ended;
    if (ended < FINALIZE_BATCH) return total;
  }
};
