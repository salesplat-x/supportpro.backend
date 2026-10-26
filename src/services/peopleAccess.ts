import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { AuthorizationError, NotFoundError } from "../utils/errors";

export interface PeopleAccess {
  isOwner: boolean;
  canManagePeople: boolean;
}

const orgRepo = () => AppDataSource.getRepository(Organization);
const memberRepo = () => AppDataSource.getRepository(OrganizationMember);

const loadAccess = async (
  userId: string,
  organizationId: string
): Promise<PeopleAccess & { organization: Organization }> => {
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

export const getPeopleAccess = async (
  userId: string,
  organizationId: string
): Promise<PeopleAccess> => {
  const { isOwner, canManagePeople } = await loadAccess(userId, organizationId);
  return { isOwner, canManagePeople };
};

export const assertCanManagePeople = async (
  userId: string,
  organizationId: string
): Promise<Organization> => {
  const access = await loadAccess(userId, organizationId);
  if (!access.canManagePeople) {
    throw new AuthorizationError("You don't have access to People in this company");
  }
  return access.organization;
};

export const assertOwner = async (
  userId: string,
  organizationId: string
): Promise<Organization> => {
  const access = await loadAccess(userId, organizationId);
  if (!access.isOwner) {
    throw new AuthorizationError("Only the company owner can do this");
  }
  return access.organization;
};
