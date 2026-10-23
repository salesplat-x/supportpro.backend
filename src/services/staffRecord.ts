import { EntityManager, In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { StaffMember, StaffStatus } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import { NotFoundError } from "../utils/errors";

export type Actor = Pick<User, "id" | "firstName" | "lastName">;

export type StaffInviteState = "none" | "pending" | "expired" | "accepted";

export interface StaffView {
  id: string;
  fullName: string;
  email: string;
  jobTitle: string;
  department: string | null;
  managerId: string | null;
  managerName: string | null;
  startDate: string;
  endDate: string | null;
  status: StaffStatus;
  hiredThroughAuxhr: boolean;
  isExecutive: boolean;
  hasAccount: boolean;
  invite: {
    state: StaffInviteState;
    invitedByName: string | null;
    invitedAt: Date | null;
    expiresAt: Date | null;
    joinedAt: Date | null;
  };
  createdAt: Date;
}

export const fullNameOf = (person: Pick<User, "firstName" | "lastName">): string =>
  `${person.firstName} ${person.lastName}`.trim();

export const isUniqueViolation = (err: unknown): boolean => {
  const candidate = err as { code?: string; driverError?: { code?: string } } | null;
  return candidate?.code === "23505" || candidate?.driverError?.code === "23505";
};

/** A person has joined when an AuxHR account is linked; deleting that account makes them invitable again. */
export const inviteStateOf = (staff: StaffMember): StaffInviteState => {
  if (staff.userId) return "accepted";
  if (!staff.inviteTokenHash) return "none";
  return staff.inviteExpiresAt && staff.inviteExpiresAt.getTime() < Date.now()
    ? "expired"
    : "pending";
};

export const toStaffView = (staff: StaffMember, managerNames: Map<string, string>): StaffView => ({
  id: staff.id,
  fullName: staff.fullName,
  email: staff.email,
  jobTitle: staff.jobTitle,
  department: staff.department,
  managerId: staff.managerId,
  managerName: staff.managerId ? (managerNames.get(staff.managerId) ?? null) : null,
  startDate: staff.startDate,
  endDate: staff.endDate,
  status: staff.status,
  hiredThroughAuxhr: staff.hiredThroughAuxhr,
  isExecutive: staff.isExecutive,
  hasAccount: !!staff.userId,
  invite: {
    state: inviteStateOf(staff),
    invitedByName: staff.invitedByName,
    invitedAt: staff.invitedAt,
    expiresAt: staff.inviteExpiresAt,
    joinedAt: staff.joinedAt,
  },
  createdAt: staff.createdAt,
});

export const loadManagerNames = async (
  rows: Pick<StaffMember, "managerId">[],
  em: EntityManager = AppDataSource.manager
): Promise<Map<string, string>> => {
  const ids = [...new Set(rows.map((row) => row.managerId).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const managers = await em.getRepository(StaffMember).find({
    where: { id: In(ids) },
    select: { id: true, fullName: true },
  });
  return new Map(managers.map((manager) => [manager.id, manager.fullName]));
};

export const viewOf = async (staff: StaffMember): Promise<StaffView> =>
  toStaffView(staff, await loadManagerNames([staff]));

/** Always scoped to the company in the path, so another company's record id is a 404. */
export const findStaff = async (
  organizationId: string,
  staffId: string,
  options: { em?: EntityManager; lock?: boolean } = {}
): Promise<StaffMember> => {
  const em = options.em ?? AppDataSource.manager;
  const staff = await em.getRepository(StaffMember).findOne({
    where: { id: staffId, organizationId },
    ...(options.lock ? { lock: { mode: "pessimistic_write" as const } } : {}),
  });
  if (!staff) {
    throw new NotFoundError("Staff member not found");
  }
  return staff;
};
