import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { User } from "../entities/User.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import {
  OrganizationJoinRequest,
  OrganizationJoinRequestStatus,
} from "../entities/OrganizationJoinRequest.js";
import { OrganizationStatus } from "../types/enums.js";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import { extractEmailDomain, isCorporateEmail, isPublicEmailDomain } from "../utils/emailDomain.js";
import { createNotification } from "./notification.js";
import { purgeOrganizationCascade } from "./cascadeDelete.js";
import logger from "../utils/logger.js";

const orgRepo = () => AppDataSource.getRepository(Organization);
const userRepo = () => AppDataSource.getRepository(User);
const memberRepo = () => AppDataSource.getRepository(OrganizationMember);
const joinReqRepo = () => AppDataSource.getRepository(OrganizationJoinRequest);

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

export interface OrganizationJoinRequestView {
  id: string;
  userId: string;
  organizationId: string;
  workEmail: string;
  status: OrganizationJoinRequestStatus;
  createdAt: Date;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
}

const assertCompanyAllowsJoinRequests = (org: Organization): void => {
  if (!org.email) {
    throw new ValidationError("This company cannot accept join requests");
  }
  if (isPublicEmailDomain(org.email)) {
    throw new ValidationError(
      "This company was registered with a personal email address. Only companies with a corporate work email domain accept team join requests."
    );
  }
};

const assertRecruiterWorkEmailMatchesCompany = (org: Organization, workEmail: string): void => {
  if (!org.email) {
    throw new ValidationError("Company email is not configured");
  }
  if (isPublicEmailDomain(workEmail)) {
    throw new ValidationError(
      "Please use your corporate work email address (e.g. name@company.com), not a personal email."
    );
  }
  const companyDomain = extractEmailDomain(org.email);
  const workDomain = extractEmailDomain(workEmail);
  if (companyDomain !== workDomain) {
    throw new ValidationError(
      `Your work email domain (@${workDomain}) must match this company's domain (@${companyDomain}).`
    );
  }
};

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

  if (payload.website) {
    const nameAndWebsiteExists = await orgRepo()
      .createQueryBuilder("organization")
      .where("LOWER(organization.name) = :name", { name: payload.name.trim().toLowerCase() })
      .andWhere("LOWER(organization.website) = :website", {
        website: payload.website.trim().toLowerCase(),
      })
      .getOne();
    if (nameAndWebsiteExists) {
      throw new ConflictError("A company with this name and website already exists");
    }
  }

  const org = orgRepo().create({
    ...payload,
    email,
    ownerId,
    status: OrganizationStatus.Pending,
  });
  const saved = await orgRepo().save(org);

  const member = memberRepo().create({
    userId: ownerId,
    organizationId: saved.id,
    workEmail: email,
    role: "owner",
  });
  await memberRepo().save(member);

  await userRepo().update({ id: ownerId }, { activeOrganizationId: saved.id });

  return saved;
};

export const listMyOrganizations = async (userId: string): Promise<Organization[]> => {
  const memberRows = await memberRepo().find({ where: { userId } });
  const memberOrgIds = memberRows.map((m) => m.organizationId);

  if (memberOrgIds.length === 0) {
    return orgRepo().find({ where: { ownerId: userId }, order: { createdAt: "DESC" } });
  }

  return orgRepo()
    .createQueryBuilder("organization")
    .where("organization.ownerId = :userId OR organization.id IN (:...orgIds)", {
      userId,
      orgIds: memberOrgIds,
    })
    .orderBy("organization.createdAt", "DESC")
    .getMany();
};

export const listVerifiedOrganizations = async (search?: string): Promise<Organization[]> => {
  const qb = orgRepo()
    .createQueryBuilder("organization")
    .where("organization.status = :status", { status: OrganizationStatus.Verified });

  if (search && search.trim()) {
    const term = `%${search.trim().toLowerCase()}%`;
    qb.andWhere(
      "(LOWER(organization.name) LIKE :term OR LOWER(organization.website) LIKE :term OR LOWER(organization.industry) LIKE :term)",
      { term }
    );
  }

  const organizations = await qb.orderBy("organization.name", "ASC").take(50).getMany();

  return organizations.filter((org) => org.email && isCorporateEmail(org.email));
};

export const requestJoinOrganization = async (
  userId: string,
  organizationId: string,
  workEmail: string
): Promise<{ message: string }> => {
  if (!workEmail || !validateEmail(workEmail)) {
    throw new ValidationError("Valid work email is required");
  }
  const email = workEmail.toLowerCase().trim();

  const org = await orgRepo().findOne({ where: { id: organizationId } });
  if (!org) {
    throw new NotFoundError("Company not found");
  }
  if (org.status !== OrganizationStatus.Verified) {
    throw new ValidationError("Company is not verified yet");
  }

  assertCompanyAllowsJoinRequests(org);
  assertRecruiterWorkEmailMatchesCompany(org, email);

  if (org.ownerId === userId) {
    throw new ConflictError("You are the owner of this company");
  }

  const existingMember = await memberRepo().findOne({
    where: { userId, organizationId: org.id },
  });
  if (existingMember) {
    throw new ConflictError("You are already associated with this company");
  }

  const user = await userRepo().findOne({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError("User not found");
  }

  const existingPending = await joinReqRepo().findOne({
    where: {
      userId,
      organizationId: org.id,
      status: OrganizationJoinRequestStatus.Pending,
    },
  });
  if (existingPending) {
    throw new ConflictError("You already have a pending join request for this company");
  }

  const joinReq = joinReqRepo().create({
    userId,
    organizationId: org.id,
    workEmail: email,
    status: OrganizationJoinRequestStatus.Pending,
  });
  await joinReqRepo().save(joinReq);

  if (org.ownerId) {
    const requesterName = `${user.firstName} ${user.lastName}`.trim() || "A recruiter";
    try {
      await createNotification(
        org.ownerId,
        `${requesterName} requested to join ${org.name} with ${email}. Review pending requests on your Company page.`,
        "New team join request"
      );
    } catch (err) {
      logger.error(
        `Join request notification failed for owner ${org.ownerId}: ${(err as Error).message}`
      );
    }
  }

  return {
    message: "Join request submitted. The company owner will review and approve your request.",
  };
};

export const listOrganizationJoinRequests = async (
  ownerId: string,
  organizationId: string
): Promise<OrganizationJoinRequestView[]> => {
  const org = await assertOwnership(ownerId, organizationId);

  assertCompanyAllowsJoinRequests(org);

  const requests = await joinReqRepo().find({
    where: {
      organizationId: org.id,
      status: OrganizationJoinRequestStatus.Pending,
    },
    relations: { user: true },
    order: { createdAt: "DESC" },
  });

  return requests.map((request) => ({
    id: request.id,
    userId: request.userId,
    organizationId: request.organizationId,
    workEmail: request.workEmail,
    status: request.status,
    createdAt: request.createdAt,
    user: {
      id: request.user.id,
      firstName: request.user.firstName,
      lastName: request.user.lastName,
      email: request.user.email,
    },
  }));
};

export const approveJoinRequest = async (
  ownerId: string,
  requestId: string
): Promise<Organization> => {
  const request = await joinReqRepo().findOne({
    where: { id: requestId },
    relations: { organization: true, user: true },
  });
  if (!request) {
    throw new NotFoundError("Join request not found");
  }
  if (request.status !== OrganizationJoinRequestStatus.Pending) {
    throw new ValidationError("This join request has already been processed");
  }

  await assertOwnership(ownerId, request.organizationId);
  assertCompanyAllowsJoinRequests(request.organization);
  assertRecruiterWorkEmailMatchesCompany(request.organization, request.workEmail);

  const existingMember = await memberRepo().findOne({
    where: { userId: request.userId, organizationId: request.organizationId },
  });
  if (existingMember) {
    request.status = OrganizationJoinRequestStatus.Approved;
    await joinReqRepo().save(request);
    throw new ConflictError("This recruiter is already a member of your company");
  }

  const member = memberRepo().create({
    userId: request.userId,
    organizationId: request.organizationId,
    workEmail: request.workEmail,
    role: "member",
  });
  await memberRepo().save(member);

  await userRepo().update({ id: request.userId }, { activeOrganizationId: request.organizationId });

  request.status = OrganizationJoinRequestStatus.Approved;
  await joinReqRepo().save(request);

  return request.organization;
};

export const rejectJoinRequest = async (ownerId: string, requestId: string): Promise<void> => {
  const request = await joinReqRepo().findOne({
    where: { id: requestId },
    relations: { organization: true },
  });
  if (!request) {
    throw new NotFoundError("Join request not found");
  }
  if (request.status !== OrganizationJoinRequestStatus.Pending) {
    throw new ValidationError("This join request has already been processed");
  }

  await assertOwnership(ownerId, request.organizationId);

  request.status = OrganizationJoinRequestStatus.Rejected;
  await joinReqRepo().save(request);
};

export const switchOrganization = async (
  userId: string,
  organizationId: string
): Promise<Organization> => {
  const org = await orgRepo().findOne({ where: { id: organizationId } });
  if (!org) {
    throw new NotFoundError("Organization not found");
  }

  const isOwner = org.ownerId === userId;
  const isMember = await memberRepo().exists({ where: { userId, organizationId: org.id } });

  if (!isOwner && !isMember) {
    throw new AuthorizationError("You can only switch to a company you created or belong to");
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
