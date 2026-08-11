import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { User } from "../entities/User.js";
import { OrganizationStatus } from "../types/enums.js";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";

const orgRepo = () => AppDataSource.getRepository(Organization);
const userRepo = () => AppDataSource.getRepository(User);

const validateEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export interface OrganizationPayload {
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  industry?: string | null;
  website?: string | null;
  facebook?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
}

export const createOrganization = async (
  ownerId: string,
  payload: OrganizationPayload
): Promise<Organization> => {
  if (!payload.email) {
    throw new ValidationError("Email is required");
  }
  if (!validateEmail(payload.email)) {
    throw new ValidationError("Invalid Email Address");
  }
  const email = payload.email.toLowerCase();

  const emailExists = await orgRepo().findOne({ where: { email } });
  if (emailExists) {
    throw new ConflictError("Organization already registered with this email");
  }

  if (payload.phone) {
    const phoneExists = await orgRepo().findOne({ where: { phone: payload.phone } });
    if (phoneExists) {
      throw new ConflictError("Organization already registered with this phone number");
    }
  }

  const org = orgRepo().create({
    ...payload,
    email,
    ownerId,
    status: OrganizationStatus.Pending,
  });
  const saved = await orgRepo().save(org);

  // Creating a company switches the recruiter onto it.
  await userRepo().update({ id: ownerId }, { activeOrganizationId: saved.id });

  return saved;
};

export const listMyOrganizations = async (ownerId: string): Promise<Organization[]> => {
  return orgRepo().find({ where: { ownerId }, order: { createdAt: "DESC" } });
};

export const switchOrganization = async (
  userId: string,
  organizationId: string
): Promise<Organization> => {
  const org = await orgRepo().findOne({ where: { id: organizationId } });
  if (!org) {
    throw new NotFoundError("Organization not found");
  }
  if (org.ownerId !== userId) {
    throw new AuthorizationError("You can only switch to a company you created");
  }

  await userRepo().update({ id: userId }, { activeOrganizationId: org.id });

  return org;
};
