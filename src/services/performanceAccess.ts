import { EntityManager, IsNull } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { StaffAccessResource } from "../entities/StaffAccessLog.js";
import { StaffMember, StaffStatus } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import { ConflictError, NotFoundError } from "../utils/errors";
import { assertCanManagePeople } from "./peopleAccess.js";
import { logStaffAccess, openStaff } from "./staffAudit.js";
import { findStaff } from "./staffRecord.js";

/** Who is acting on someone's performance data, and by which right. Being a manager never grants HR rights. */
export type PerformanceScope =
  | { kind: "hr"; actor: User; organizationId: string; staffId: string }
  | { kind: "manager"; actor: User; managerStaffId: string; staffId: string };

const notOnYourTeam = () => new NotFoundError("This person is not on your team");

const findOwnOpenRecord = (userId: string, staffId: string, em: EntityManager) =>
  em.getRepository(StaffMember).findOne({ where: { id: staffId, userId, endDate: IsNull() } });

export const findOwnStaff = async (
  userId: string,
  staffId: string,
  em: EntityManager = AppDataSource.manager
): Promise<StaffMember> => {
  const staff = await findOwnOpenRecord(userId, staffId, em);
  if (!staff) {
    throw new NotFoundError("Record not found");
  }
  return staff;
};

export const logPerformanceRead = (
  actor: User,
  staff: { id: string | null; fullName: string; organizationId: string },
  ip: string
): Promise<void> =>
  logStaffAccess({
    organizationId: staff.organizationId,
    actor,
    staff,
    resource: StaffAccessResource.Performance,
    ip,
  });

/** Direct reports only: the report's manager must be this person's own open staff record. */
const findTeamMember = async (
  scope: Extract<PerformanceScope, { kind: "manager" }>,
  em: EntityManager,
  lock: boolean
): Promise<StaffMember> => {
  const manager = await findOwnOpenRecord(scope.actor.id, scope.managerStaffId, em);
  if (!manager) {
    throw notOnYourTeam();
  }
  const report = await em.getRepository(StaffMember).findOne({
    where: {
      id: scope.staffId,
      managerId: manager.id,
      organizationId: manager.organizationId,
      endDate: IsNull(),
    },
    ...(lock ? { lock: { mode: "pessimistic_write" as const } } : {}),
  });
  if (!report) {
    throw notOnYourTeam();
  }
  return report;
};

/** For reads: checks the right, then writes the log line before any data is loaded. */
export const openPerformance = async (
  scope: PerformanceScope,
  ip: string
): Promise<StaffMember> => {
  if (scope.kind === "hr") {
    return openStaff(
      scope.actor,
      scope.organizationId,
      scope.staffId,
      StaffAccessResource.Performance,
      ip
    );
  }
  const report = await findTeamMember(scope, AppDataSource.manager, false);
  await logPerformanceRead(scope.actor, report, ip);
  return report;
};

/**
 * Gate for every performance write. An assigned HR can read through `openPerformance` but
 * can't write, so this needs the switch. Call it before opening the transaction: HR rights
 * are read on their own connection.
 */
export const assertScope = async (scope: PerformanceScope): Promise<void> => {
  if (scope.kind === "hr") {
    await assertCanManagePeople(scope.actor.id, scope.organizationId);
  }
};

/**
 * Locks only the report's row, which alone stops their manager changing under this write.
 * The manager's row is never locked, so this can't deadlock with `updateStaff`, which
 * locks people in the opposite order.
 */
export const lockScopedStaff = async (
  scope: PerformanceScope,
  em: EntityManager
): Promise<StaffMember> => {
  const staff =
    scope.kind === "hr"
      ? await findStaff(scope.organizationId, scope.staffId, { em, lock: true })
      : await findTeamMember(scope, em, true);
  assertWritable(staff);
  return staff;
};

export const assertWritable = (staff: StaffMember): void => {
  if (staff.status === StaffStatus.Ended) {
    throw new ConflictError("This person's employment has ended");
  }
};

export const lockOwnStaff = async (
  userId: string,
  staffId: string,
  em: EntityManager
): Promise<StaffMember> => {
  const staff = await em.getRepository(StaffMember).findOne({
    where: { id: staffId, userId, endDate: IsNull() },
    lock: { mode: "pessimistic_write" },
  });
  if (!staff) {
    throw new NotFoundError("Record not found");
  }
  return staff;
};
