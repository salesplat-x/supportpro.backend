import { EntityManager } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { StaffHrAssignment } from "../entities/StaffHrAssignment.js";
import { StaffMember } from "../entities/StaffMember.js";
import { User } from "../entities/User.js";
import { AppError, AuthorizationError, ConflictError, NotFoundError } from "../utils/errors";
import { createNotification } from "./notification.js";

const ACCESS_REQUEST_COOLDOWN_HOURS = 24;

export interface PeopleAccess {
  isOwner: boolean;
  canManagePeople: boolean;
  /** How many current employees this person has been assigned to track. */
  assignedCount: number;
  ownerFirstName: string | null;
  /** True while this person's ask for access is still within its one-a-day limit. */
  accessRequested: boolean;
}

const loadAccess = async (
  userId: string,
  organizationId: string,
  em: EntityManager = AppDataSource.manager
): Promise<{
  isOwner: boolean;
  canManagePeople: boolean;
  organization: Organization;
  member: OrganizationMember | null;
}> => {
  const organization = await em.getRepository(Organization).findOne({
    where: { id: organizationId },
  });
  if (!organization) {
    throw new NotFoundError("Company not found");
  }
  if (organization.ownerId === userId) {
    return { organization, isOwner: true, canManagePeople: true, member: null };
  }
  const member = await em
    .getRepository(OrganizationMember)
    .findOne({ where: { userId, organizationId } });
  if (!member) {
    throw new AuthorizationError("You are not a member of this company");
  }
  return { organization, isOwner: false, canManagePeople: member.canManagePeople, member };
};

const assignmentsOf = (
  userId: string,
  organizationId: string,
  em: EntityManager = AppDataSource.manager
) =>
  em
    .getRepository(StaffHrAssignment)
    .createQueryBuilder("assignment")
    .innerJoin(StaffMember, "staff", "staff.id = assignment.staffId")
    .where("assignment.assigneeUserId = :userId", { userId })
    .andWhere("staff.organizationId = :organizationId", { organizationId })
    .andWhere("staff.endDate IS NULL");

export const getPeopleAccess = async (
  userId: string,
  organizationId: string
): Promise<PeopleAccess> => {
  const { isOwner, canManagePeople, organization, member } = await loadAccess(
    userId,
    organizationId
  );
  const [assignedCount, owner] = await Promise.all([
    assignmentsOf(userId, organizationId).getCount(),
    organization.ownerId
      ? AppDataSource.getRepository(User).findOneBy({ id: organization.ownerId })
      : null,
  ]);
  const requestedAt = member?.peopleAccessRequestedAt;
  return {
    isOwner,
    canManagePeople,
    assignedCount,
    ownerFirstName: owner?.firstName ?? null,
    accessRequested:
      !!requestedAt &&
      requestedAt.getTime() > Date.now() - ACCESS_REQUEST_COOLDOWN_HOURS * 3_600_000,
  };
};

export const requestPeopleAccess = async (user: User, organizationId: string): Promise<void> => {
  const { isOwner, canManagePeople, organization } = await loadAccess(user.id, organizationId);
  const hasAssignments = await assignmentsOf(user.id, organizationId).getExists();
  if (isOwner || canManagePeople || hasAssignments) {
    throw new ConflictError("You already have access to People");
  }
  if (!organization.ownerId) {
    throw new NotFoundError("This company has no creator to ask");
  }

  const claimed = await AppDataSource.getRepository(OrganizationMember)
    .createQueryBuilder()
    .update()
    .set({ peopleAccessRequestedAt: () => "now()" })
    .where("user_id = :userId AND organization_id = :organizationId", {
      userId: user.id,
      organizationId,
    })
    .andWhere(
      `(people_access_requested_at IS NULL
        OR people_access_requested_at < now() - make_interval(hours => :hours))`,
      { hours: ACCESS_REQUEST_COOLDOWN_HOURS }
    )
    .execute();
  if (!claimed.affected) {
    throw new AppError(429, "TOO_MANY_REQUESTS", "You already asked. Try again tomorrow.");
  }

  try {
    await createNotification(
      organization.ownerId,
      `${`${user.firstName} ${user.lastName}`.trim()} asked for access to People in ${organization.name}.`,
      "Access request"
    );
  } catch (err) {
    await AppDataSource.getRepository(OrganizationMember).update(
      { userId: user.id, organizationId },
      { peopleAccessRequestedAt: null }
    );
    throw err;
  }
};

const noPeopleAccess = () =>
  new AuthorizationError("You don't have access to People in this company");

export const assertCanManagePeople = async (
  userId: string,
  organizationId: string
): Promise<Organization> => {
  const access = await loadAccess(userId, organizationId);
  if (!access.canManagePeople) {
    throw noPeopleAccess();
  }
  return access.organization;
};

/**
 * Who can see one person's record, activity and performance, but never their pay or contracts.
 * Someone with assignments gets a 404 for anyone else, so they can't tell who works here.
 */
export const assertCanViewStaff = async (
  userId: string,
  organizationId: string,
  staffId: string,
  em: EntityManager = AppDataSource.manager
): Promise<void> => {
  const access = await loadAccess(userId, organizationId, em);
  if (access.canManagePeople) return;

  const assignments = assignmentsOf(userId, organizationId, em);
  if (await assignments.clone().andWhere("staff.id = :staffId", { staffId }).getExists()) return;
  if (await assignments.getExists()) {
    throw new NotFoundError("Staff member not found");
  }
  throw noPeopleAccess();
};

/** True when this person sees only the employees assigned to them. */
export const seesOnlyAssignedStaff = async (
  userId: string,
  organizationId: string
): Promise<boolean> => {
  const access = await loadAccess(userId, organizationId);
  if (access.canManagePeople) return false;
  if (await assignmentsOf(userId, organizationId).getExists()) return true;
  throw noPeopleAccess();
};

export const assertOwner = async (
  userId: string,
  organizationId: string
): Promise<Organization> => {
  const access = await loadAccess(userId, organizationId);
  if (!access.isOwner) {
    throw new AuthorizationError("Only the company's creator can do this");
  }
  return access.organization;
};
