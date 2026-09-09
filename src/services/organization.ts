import crypto from "crypto";
import { Not } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { User } from "../entities/User.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import {
  OrganizationJoinRequest,
  OrganizationJoinRequestStatus,
} from "../entities/OrganizationJoinRequest.js";
import { OrganizationInvite, OrganizationInviteStatus } from "../entities/OrganizationInvite.js";
import { OrganizationStatus, UserRole } from "../types/enums.js";
import env from "../config/env.js";
import EmailService from "../utils/integrations/email/emailService.js";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import {
  emailDomainMatchesWebsite,
  extractEmailDomain,
  extractWebsiteDomain,
  isCorporateEmail,
  isPublicEmailDomain,
} from "../utils/emailDomain.js";
import { createNotification } from "./notification.js";
import { purgeOrganizationCascade } from "./cascadeDelete.js";
import logger from "../utils/logger.js";

const orgRepo = () => AppDataSource.getRepository(Organization);
const userRepo = () => AppDataSource.getRepository(User);
const memberRepo = () => AppDataSource.getRepository(OrganizationMember);
const joinReqRepo = () => AppDataSource.getRepository(OrganizationJoinRequest);
const inviteRepo = () => AppDataSource.getRepository(OrganizationInvite);

const INVITE_EXPIRY_DAYS = 7;

/** Recruiters who can sit on a company in addition to the creator. */
export const MAX_COMPANY_TEAMMATES = 6;

const TEAM_FULL_MESSAGE =
  "This company already has 6 recruiters plus the creator. Remove a teammate before adding another.";

export interface OrganizationInviteView {
  id: string;
  organizationId: string;
  email: string;
  status: OrganizationInviteStatus;
  expiresAt: Date;
  createdAt: Date;
}

export interface OrganizationInvitePreview {
  organizationName: string;
  invitedEmail: string;
  status: OrganizationInviteStatus;
  expiresAt: Date;
}

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

export interface OrganizationMemberUserView {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface OrganizationMemberView {
  id: string;
  userId: string;
  organizationId: string;
  workEmail: string;
  role: string;
  createdAt: Date;
  user: OrganizationMemberUserView;
}

export interface OrganizationJoinRequestView {
  id: string;
  userId: string;
  organizationId: string;
  workEmail: string;
  status: OrganizationJoinRequestStatus;
  createdAt: Date;
  user: OrganizationMemberUserView;
}

const toMemberUserView = (user: User): OrganizationMemberUserView => ({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
});

const toMemberView = (member: OrganizationMember): OrganizationMemberView => ({
  id: member.id,
  userId: member.userId,
  organizationId: member.organizationId,
  workEmail: member.workEmail,
  role: member.role,
  createdAt: member.createdAt,
  user: toMemberUserView(member.user),
});

export const loadOrganizationMembers = async (
  organizationId: string
): Promise<OrganizationMemberView[]> => {
  const members = await memberRepo().find({
    where: { organizationId },
    relations: { user: true },
    order: { createdAt: "ASC" },
  });

  return members.map(toMemberView).sort((a, b) => {
    if (a.role === "owner" && b.role !== "owner") return -1;
    if (b.role === "owner" && a.role !== "owner") return 1;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
};

const countCompanyTeammates = async (organizationId: string): Promise<number> => {
  return memberRepo().count({
    where: { organizationId, role: Not("owner") },
  });
};

const countPendingInvites = async (organizationId: string): Promise<number> => {
  const invites = await inviteRepo().find({
    where: {
      organizationId,
      status: OrganizationInviteStatus.Pending,
    },
  });
  return invites.filter((invite) => invite.expiresAt.getTime() >= Date.now()).length;
};

const assertCompanyHasOpenSeat = async (organizationId: string): Promise<void> => {
  const teammates = await countCompanyTeammates(organizationId);
  if (teammates >= MAX_COMPANY_TEAMMATES) {
    throw new ValidationError(TEAM_FULL_MESSAGE);
  }
};

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

  if (isPublicEmailDomain(email)) {
    throw new ValidationError(
      "Please use a corporate work email address (e.g. name@company.com), not a personal email."
    );
  }

  if (payload.website) {
    if (!emailDomainMatchesWebsite(email, payload.website)) {
      const websiteDomain = extractWebsiteDomain(payload.website);
      throw new ValidationError(
        `Contact email domain must match your website domain (@${websiteDomain || "your website"}).`
      );
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

  await assertCompanyHasOpenSeat(request.organizationId);

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

export const listOrganizationMembers = async (
  ownerId: string,
  organizationId: string
): Promise<OrganizationMemberView[]> => {
  await assertOwnership(ownerId, organizationId);
  return loadOrganizationMembers(organizationId);
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

const generateInviteToken = (): string => crypto.randomBytes(32).toString("hex");

const resolveInviteStatus = (invite: OrganizationInvite): OrganizationInviteStatus => {
  if (
    invite.status === OrganizationInviteStatus.Pending &&
    invite.expiresAt.getTime() < Date.now()
  ) {
    return OrganizationInviteStatus.Expired;
  }
  return invite.status;
};

const findInviteByToken = async (token: string): Promise<OrganizationInvite | null> => {
  return inviteRepo().findOne({
    where: { token },
    relations: { organization: true },
  });
};

const assertInviteUsable = (invite: OrganizationInvite): void => {
  const status = resolveInviteStatus(invite);
  if (status === OrganizationInviteStatus.Revoked) {
    throw new ValidationError("This invite has been revoked");
  }
  if (status === OrganizationInviteStatus.Expired) {
    throw new ValidationError("This invite has expired");
  }
  if (status === OrganizationInviteStatus.Accepted) {
    throw new ValidationError("This invite has already been accepted");
  }
};

export const sendOrganizationInvite = async (
  ownerId: string,
  organizationId: string,
  inviteEmail: string
): Promise<OrganizationInviteView> => {
  if (!validateEmail(inviteEmail)) {
    throw new ValidationError("Valid email is required");
  }
  const email = inviteEmail.toLowerCase().trim();

  const org = await assertOwnership(ownerId, organizationId);
  assertCompanyAllowsJoinRequests(org);
  assertRecruiterWorkEmailMatchesCompany(org, email);

  const teammates = await countCompanyTeammates(org.id);
  const pendingInvites = await countPendingInvites(org.id);
  if (teammates + pendingInvites >= MAX_COMPANY_TEAMMATES) {
    throw new ValidationError(TEAM_FULL_MESSAGE);
  }

  const existingUser = await userRepo().findOne({ where: { email } });
  if (existingUser) {
    const existingMember = await memberRepo().findOne({
      where: { userId: existingUser.id, organizationId: org.id },
    });
    if (existingMember) {
      throw new ConflictError("This person is already a member of your company");
    }
  }

  const existingPending = await inviteRepo().findOne({
    where: {
      organizationId: org.id,
      email,
      status: OrganizationInviteStatus.Pending,
    },
  });
  if (
    existingPending &&
    resolveInviteStatus(existingPending) === OrganizationInviteStatus.Pending
  ) {
    throw new ConflictError("An invite has already been sent to this email");
  }

  const owner = await userRepo().findOne({ where: { id: ownerId } });
  if (!owner) {
    throw new NotFoundError("User not found");
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + INVITE_EXPIRY_DAYS);

  const invite = inviteRepo().create({
    organizationId: org.id,
    email,
    token: generateInviteToken(),
    invitedById: ownerId,
    status: OrganizationInviteStatus.Pending,
    expiresAt,
  });
  const saved = await inviteRepo().save(invite);

  const inviteLink = `${env.website}/join-company/${saved.token}`;
  new EmailService()
    .sendCompanyInvite({
      email,
      firstName: email.split("@")[0] ?? "there",
      companyName: org.name,
      inviterName: `${owner.firstName} ${owner.lastName}`.trim() || "Your team",
      inviteLink,
    })
    .catch((err: Error) =>
      logger.error(`Company invite email failed for ${email}: ${err.message}`)
    );

  return {
    id: saved.id,
    organizationId: saved.organizationId,
    email: saved.email,
    status: saved.status,
    expiresAt: saved.expiresAt,
    createdAt: saved.createdAt,
  };
};

export const listOrganizationInvites = async (
  ownerId: string,
  organizationId: string
): Promise<OrganizationInviteView[]> => {
  const org = await assertOwnership(ownerId, organizationId);

  const invites = await inviteRepo().find({
    where: {
      organizationId: org.id,
      status: OrganizationInviteStatus.Pending,
    },
    order: { createdAt: "DESC" },
  });

  return invites
    .map((invite) => ({
      id: invite.id,
      organizationId: invite.organizationId,
      email: invite.email,
      status: resolveInviteStatus(invite),
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
    }))
    .filter((invite) => invite.status === OrganizationInviteStatus.Pending);
};

export const revokeOrganizationInvite = async (
  ownerId: string,
  organizationId: string,
  inviteId: string
): Promise<void> => {
  await assertOwnership(ownerId, organizationId);

  const invite = await inviteRepo().findOne({
    where: { id: inviteId, organizationId },
  });
  if (!invite) {
    throw new NotFoundError("Invite not found");
  }
  if (invite.status !== OrganizationInviteStatus.Pending) {
    throw new ValidationError("Only pending invites can be revoked");
  }

  invite.status = OrganizationInviteStatus.Revoked;
  await inviteRepo().save(invite);
};

export const getOrganizationInvitePreview = async (
  token: string
): Promise<OrganizationInvitePreview> => {
  const invite = await findInviteByToken(token);
  if (!invite) {
    throw new NotFoundError("Invite not found");
  }

  const status = resolveInviteStatus(invite);
  if (status !== OrganizationInviteStatus.Pending) {
    throw new ValidationError(
      status === OrganizationInviteStatus.Expired
        ? "This invite has expired"
        : "This invite is no longer valid"
    );
  }

  return {
    organizationName: invite.organization.name,
    invitedEmail: invite.email,
    status,
    expiresAt: invite.expiresAt,
  };
};

export const acceptOrganizationInvite = async (
  userId: string,
  token: string
): Promise<Organization> => {
  const invite = await findInviteByToken(token);
  if (!invite) {
    throw new NotFoundError("Invite not found");
  }

  assertInviteUsable(invite);

  const user = await userRepo().findOne({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError("User not found");
  }
  if (user.userRole !== UserRole.Recruiter) {
    throw new AuthorizationError("Only recruiters can join a company");
  }
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw new AuthorizationError("Sign in with the email address this invite was sent to");
  }

  assertCompanyAllowsJoinRequests(invite.organization);
  assertRecruiterWorkEmailMatchesCompany(invite.organization, invite.email);

  const existingMember = await memberRepo().findOne({
    where: { userId, organizationId: invite.organizationId },
  });
  if (existingMember) {
    invite.status = OrganizationInviteStatus.Accepted;
    await inviteRepo().save(invite);
    throw new ConflictError("You are already a member of this company");
  }

  await assertCompanyHasOpenSeat(invite.organizationId);

  const member = memberRepo().create({
    userId,
    organizationId: invite.organizationId,
    workEmail: invite.email,
    role: "member",
  });
  await memberRepo().save(member);

  await userRepo().update({ id: userId }, { activeOrganizationId: invite.organizationId });

  invite.status = OrganizationInviteStatus.Accepted;
  await inviteRepo().save(invite);

  return invite.organization;
};
