import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { User } from "../entities/User.js";
import { OrganizationStatus } from "../types/enums.js";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import { purgeOrganizationCascade } from "./cascadeDelete.js";

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
  logoUrl?: string | null;
}

// Email and website are deliberately absent — they are immutable after creation.
export interface UpdateOrganizationPayload {
  name?: string;
  phone?: string | null;
  address?: string | null;
  industry?: string | null;
  facebook?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
  logoUrl?: string | null;
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

const assertOwnership = async (ownerId: string, organizationId: string): Promise<Organization> => {
  const org = await orgRepo().findOne({ where: { id: organizationId } });
  if (!org) {
    throw new NotFoundError("Company not found");
  }
  if (org.ownerId !== ownerId) {
    throw new AuthorizationError("You can only manage a company you created");
  }
  return org;
};

export const updateOrganization = async (
  ownerId: string,
  organizationId: string,
  payload: UpdateOrganizationPayload
): Promise<Organization> => {
  const org = await assertOwnership(ownerId, organizationId);

  // Belt-and-braces against a client sending them anyway: the validator does not
  // whitelist email/website, but nothing stops them arriving in the body.
  const {
    email: _email,
    website: _website,
    ...allowed
  } = payload as UpdateOrganizationPayload & { email?: string; website?: string };

  const updates = Object.fromEntries(
    Object.entries(allowed).filter(([, value]) => value !== undefined)
  ) as UpdateOrganizationPayload;

  if (Object.keys(updates).length === 0) {
    return org;
  }

  if (updates.phone) {
    const phoneOwner = await orgRepo().findOne({ where: { phone: updates.phone } });
    if (phoneOwner && phoneOwner.id !== org.id) {
      throw new ConflictError("Another company is already registered with this phone number");
    }
  }

  return orgRepo().save({ ...org, ...updates });
};

export const deleteOrganization = async (
  ownerId: string,
  organizationId: string
): Promise<void> => {
  await assertOwnership(ownerId, organizationId);

  await AppDataSource.transaction(async (manager) => {
    await purgeOrganizationCascade(manager, organizationId);
  });
};
