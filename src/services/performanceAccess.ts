import { EntityManager, IsNull } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Department } from "../entities/Department.js";
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

/**
 * Someone on this person's team: a direct report, or anyone in a department this person heads.
 * Never the person themself, and only while both records are open.
 */
const findTeamMember = async (
  scope: Extract<PerformanceScope, { kind: "manager" }>,
  em: EntityManager,
  lock: boolean
): Promise<StaffMember> => {
  const manager = await findOwnOpenRecord(scope.actor.id, scope.managerStaffId, em);
  if (!manager) {
    throw notOnYourTeam();
  }
  const query = em
    .getRepository(StaffMember)
    .createQueryBuilder("staff")
    .where("staff.id = :staffId", { staffId: scope.staffId })
    .andWhere("staff.organizationId = :organizationId", {
      organizationId: manager.organizationId,
    })
    .andWhere("staff.endDate IS NULL")
    .andWhere("staff.id <> :managerId", { managerId: manager.id })
    .andWhere(
      `(staff.managerId = :managerId OR staff.departmentId IN (
        SELECT d.id FROM departments d WHERE d.head_staff_id = :managerId
      ))`
    );
  const report = await (lock ? query.setLock("pessimistic_write") : query).getOne();
  if (!report) {
    throw notOnYourTeam();
  }
  return report;
};

/**
 * A department head opening one person's record. Only people in a department they head, not
 * direct reports elsewhere, and the read is logged before anything is returned.
 */
export const openDepartmentMember = async (
  actor: User,
  headStaffId: string,
  staffId: string,
  ip: string
): Promise<StaffMember> => {
  const em = AppDataSource.manager;
  const member = await findTeamMember(
    { kind: "manager", actor, managerStaffId: headStaffId, staffId },
    em,
    false
  );
  const heads =
    member.departmentId !== null &&
    (await em
      .getRepository(Department)
      .existsBy({ id: member.departmentId, headStaffId: headStaffId }));
  if (!heads) {
    throw notOnYourTeam();
  }
  await logStaffAccess({
    organizationId: member.organizationId,
    actor,
    staff: member,
    resource: StaffAccessResource.StaffRecord,
    ip,
  });
  return member;
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
