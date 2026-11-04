import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { StaffHrAssignment } from "../entities/StaffHrAssignment.js";
import { StaffMember } from "../entities/StaffMember.js";
import { AuthorizationError, NotFoundError } from "../utils/errors";

export interface PeopleAccess {
  isOwner: boolean;
  canManagePeople: boolean;
  /** How many current employees this person has been assigned to track. */
  assignedCount: number;
}

const orgRepo = () => AppDataSource.getRepository(Organization);
const memberRepo = () => AppDataSource.getRepository(OrganizationMember);

const loadAccess = async (
  userId: string,
  organizationId: string
): Promise<{ isOwner: boolean; canManagePeople: boolean; organization: Organization }> => {
  const organization = await orgRepo().findOne({ where: { id: organizationId } });
  if (!organization) {
    throw new NotFoundError("Company not found");
  }
  if (organization.ownerId === userId) {
    return { organization, isOwner: true, canManagePeople: true };
  }
  const member = await memberRepo().findOne({ where: { userId, organizationId } });
  if (!member) {
    throw new AuthorizationError("You are not a member of this company");
  }
  return { organization, isOwner: false, canManagePeople: member.canManagePeople };
};

const assignmentsOf = (userId: string, organizationId: string) =>
  AppDataSource.getRepository(StaffHrAssignment)
    .createQueryBuilder("assignment")
    .innerJoin(StaffMember, "staff", "staff.id = assignment.staffId")
    .where("assignment.assigneeUserId = :userId", { userId })
    .andWhere("staff.organizationId = :organizationId", { organizationId })
    .andWhere("staff.endDate IS NULL");

export const getPeopleAccess = async (
  userId: string,
  organizationId: string
): Promise<PeopleAccess> => {
  const { isOwner, canManagePeople } = await loadAccess(userId, organizationId);
  const assignedCount = await assignmentsOf(userId, organizationId).getCount();
  return { isOwner, canManagePeople, assignedCount };
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
  staffId: string
): Promise<void> => {
  const access = await loadAccess(userId, organizationId);
  if (access.canManagePeople) return;

  const assignments = assignmentsOf(userId, organizationId);
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
