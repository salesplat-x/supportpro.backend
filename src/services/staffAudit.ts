import { EntityManager, FindOptionsWhere, In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { StaffAccessLog, StaffAccessResource } from "../entities/StaffAccessLog.js";
import { StaffActivity, StaffActivityType } from "../entities/StaffActivity.js";
import type { StaffMember } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import {
  assertCanManagePeople,
  assertCanViewStaff,
  assertOwner,
  getPeopleAccess,
} from "./peopleAccess.js";
import { Actor, findStaff, fullNameOf } from "./staffRecord.js";

const MAX_ACTIVITY_ROWS = 200;

/** Anything not listed here is creator-only, so a new resource starts out private. */
const VIEWABLE_WITHOUT_BEING_CREATOR = new Set<StaffAccessResource>([
  StaffAccessResource.StaffRecord,
  StaffAccessResource.StaffActivity,
  StaffAccessResource.Performance,
]);

const READABLE_BY_PEOPLE_MANAGERS = new Set<StaffAccessResource>([StaffAccessResource.Pay]);

/** Pay, share and contract events are left out, so a new event type starts out creator-only. */
const PERFORMANCE_ACTIVITY = [
  StaffActivityType.Created,
  StaffActivityType.Joined,
  StaffActivityType.Updated,
  StaffActivityType.Ended,
  StaffActivityType.JobDescriptionSaved,
  StaffActivityType.GoalAdded,
  StaffActivityType.GoalsSuggested,
  StaffActivityType.GoalChanged,
  StaffActivityType.GoalApproved,
  StaffActivityType.GoalRemoved,
  StaffActivityType.GoalProgressUpdated,
  StaffActivityType.WeeklyReportSubmitted,
  StaffActivityType.ReportNoteAdded,
  StaffActivityType.DevelopmentItemAdded,
  StaffActivityType.DevelopmentItemRemoved,
  StaffActivityType.FeedbackSaved,
  StaffActivityType.CompletionRequested,
  StaffActivityType.CompletionApproved,
  StaffActivityType.CompletionReturned,
  StaffActivityType.CompletionReopened,
  StaffActivityType.HrAssigned,
  StaffActivityType.HrRemoved,
];

const INVITE_ACTIVITY = [
  StaffActivityType.Invited,
  StaffActivityType.InviteResent,
  StaffActivityType.InviteFailed,
  StaffActivityType.InviteOpened,
];

const ACCESS_LABELS: Record<StaffAccessResource, string> = {
  [StaffAccessResource.StaffRecord]: "Staff record",
  [StaffAccessResource.StaffActivity]: "Activity",
  [StaffAccessResource.Pay]: "Pay",
  [StaffAccessResource.Contract]: "Contracts",
  [StaffAccessResource.HeadcountCost]: "Headcount cost",
  [StaffAccessResource.Performance]: "Performance",
};

/** Someone with no account behind the read, such as whoever holds an emailed link. */
export type AccessActor = Actor | { id: null; name: string };

export interface ActivityEntry {
  type: StaffActivityType;
  actorId: string | null;
  actorName: string;
  meta?: Record<string, unknown> | null;
}

export interface StaffActivityView {
  id: string;
  type: StaffActivityType;
  actorId: string | null;
  actorName: string;
  meta: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AccessLogView {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actorName: string;
  staffId: string | null;
  staffName: string;
  resource: StaffAccessResource;
  description: string;
  ip: string | null;
}

export interface AccessLogQuery {
  staffId?: string;
  actorId?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export const activityEntry = (
  type: StaffActivityType,
  actor: Actor,
  meta?: Record<string, unknown>
): ActivityEntry => ({ type, actorId: actor.id, actorName: fullNameOf(actor), meta });

let lastStamp = 0;

/** Strictly increasing, so events written back to back never tie when the timeline is sorted. */
const nextStamp = (): Date => {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp);
};

export const recordActivities = async (
  em: EntityManager,
  staff: Pick<StaffMember, "id" | "organizationId">,
  entries: ActivityEntry[]
): Promise<void> => {
  const repo = em.getRepository(StaffActivity);
  await repo.save(
    entries.map((entry) =>
      repo.create({
        organizationId: staff.organizationId,
        staffId: staff.id,
        actorId: entry.actorId,
        actorName: entry.actorName,
        type: entry.type,
        meta: entry.meta ?? null,
        createdAt: nextStamp(),
      })
    )
  );
};

/**
 * Called before any staff data is returned: if the line cannot be written the
 * request fails, so nothing is ever read without being logged. Pay, contract
 * and performance reads must go through this too.
 */
export const logStaffAccess = async (input: {
  organizationId: string;
  actor: AccessActor;
  staff: { id: string | null; fullName: string };
  resource: StaffAccessResource;
  ip: string;
  em?: EntityManager;
}): Promise<void> => {
  const manager = input.em ?? AppDataSource.manager;
  await manager.getRepository(StaffAccessLog).insert({
    organizationId: input.organizationId,
    actorId: input.actor.id,
    actorName: "name" in input.actor ? input.actor.name : fullNameOf(input.actor),
    staffId: input.staff.id,
    staffName: input.staff.fullName,
    resource: input.resource,
    ip: input.ip || null,
    createdAt: new Date(),
  });
};

/** A read of one person's data: checks access for that resource, finds the record, logs the view. */
export const openStaff = async (
  actor: User,
  organizationId: string,
  staffId: string,
  resource: StaffAccessResource,
  ip: string
): Promise<StaffMember> => {
  if (VIEWABLE_WITHOUT_BEING_CREATOR.has(resource)) {
    await assertCanViewStaff(actor.id, organizationId, staffId);
  } else if (READABLE_BY_PEOPLE_MANAGERS.has(resource)) {
    await assertCanManagePeople(actor.id, organizationId);
  } else {
    await assertOwner(actor.id, organizationId);
  }
  const staff = await findStaff(organizationId, staffId);
  await logStaffAccess({ organizationId, actor, staff, resource, ip });
  return staff;
};

export const listActivity = async (
  actor: User,
  organizationId: string,
  staffId: string,
  ip: string
): Promise<StaffActivityView[]> => {
  await openStaff(actor, organizationId, staffId, StaffAccessResource.StaffActivity, ip);

  const { isOwner, canManagePeople } = await getPeopleAccess(actor.id, organizationId);
  const where: FindOptionsWhere<StaffActivity> = { staffId, organizationId };
  if (!isOwner) {
    where.type = In(
      canManagePeople ? [...PERFORMANCE_ACTIVITY, ...INVITE_ACTIVITY] : PERFORMANCE_ACTIVITY
    );
  }

  const rows = await AppDataSource.getRepository(StaffActivity).find({
    where,
    order: { createdAt: "DESC" },
    take: MAX_ACTIVITY_ROWS,
  });
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    actorId: row.actorId,
    actorName: row.actorName,
    meta: row.meta,
    createdAt: row.createdAt,
  }));
};

export const listAccessLog = async (
  userId: string,
  organizationId: string,
  query: AccessLogQuery
): Promise<{ items: AccessLogView[]; total: number }> => {
  await assertOwner(userId, organizationId);

  const qb = AppDataSource.getRepository(StaffAccessLog)
    .createQueryBuilder("log")
    .where("log.organizationId = :organizationId", { organizationId });
  if (query.staffId) {
    qb.andWhere("log.staffId = :staffId", { staffId: query.staffId });
  }
  if (query.actorId) {
    qb.andWhere("log.actorId = :actorId", { actorId: query.actorId });
  }
  if (query.from) {
    qb.andWhere("log.createdAt >= CAST(:from AS date)", { from: query.from });
  }
  if (query.to) {
    qb.andWhere("log.createdAt < CAST(:to AS date) + INTERVAL '1 day'", { to: query.to });
  }
  const [rows, total] = await qb
    .orderBy("log.createdAt", "DESC")
    .addOrderBy("log.id", "ASC")
    .take(query.limit)
    .skip(query.offset)
    .getManyAndCount();

  return {
    items: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      actorId: row.actorId,
      actorName: row.actorName,
      staffId: row.staffId,
      staffName: row.staffName,
      resource: row.resource,
      description: `${ACCESS_LABELS[row.resource]} of ${row.staffName}`,
      ip: row.ip,
    })),
    total,
  };
};
