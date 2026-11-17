import crypto from "crypto";
import { EntityManager, In } from "typeorm";
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
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PlanLimitError,
  ValidationError,
} from "../utils/errors";
import {
  assertWithinLimit,
  ensureOrganizationBillingCurrent,
  getPlanFeature,
} from "./entitlements.js";
import { isUniqueViolation } from "./staffRecord.js";
import {
  uploadToSpaces,
  deleteSpacesObjectQuietly,
  spacesKeyFor,
  ALLOWED_IMAGE_TYPES,
} from "../utils/integrations/spaces.js";
import {
  emailDomainMatchesWebsite,
  emailMatchesCompanyDomain,
  extractEmailDomain,
  extractWebsiteDomain,
  isCorporateEmail,
  isPublicEmailDomain,
  isValidLinkedinUrl,
  normalizeCompanyDomain,
} from "../utils/emailDomain.js";
import { createNotification } from "./notification.js";
import { purgeOrganizationCascade } from "./cascadeDelete.js";
import { disablePaystackSubscriptions } from "./payment.js";
import logger from "../utils/logger.js";
import { deleteEvidenceQuietly, evidenceKeysFor } from "./completionRequests.js";

const orgRepo = () => AppDataSource.getRepository(Organization);
const userRepo = () => AppDataSource.getRepository(User);
const memberRepo = () => AppDataSource.getRepository(OrganizationMember);
const joinReqRepo = () => AppDataSource.getRepository(OrganizationJoinRequest);
const inviteRepo = () => AppDataSource.getRepository(OrganizationInvite);

export const INVITE_EXPIRY_DAYS = 7;

const assertCompanyHasOpenSeat = async (organizationId: string): Promise<void> => {
  const org = await orgRepo().findOne({ where: { id: organizationId } });
  if (!org) {
    throw new NotFoundError("Organization not found");
  }
  const pendingInvites = await countPendingInvites(organizationId);
  await assertWithinLimit(org, "team_members", async () => {
    const members = await memberRepo().count({ where: { organizationId } });
    return members + pendingInvites;
  });
};

interface NewMember {
  organizationId: string;
  userId: string;
  workEmail: string;
  onAdded?: (manager: EntityManager) => Promise<void>;
}

/**
 * The only way a recruiter becomes a company member. The company row is locked while
 * seats are counted and the member is added, so two joins can't both take the last seat.
 * Billing can write to that row, so it is brought up to date before the lock and the
 * check inside reads the plan without touching billing.
 */
const addMemberWithSeat = async ({
  organizationId,
  userId,
  workEmail,
  onAdded,
}: NewMember): Promise<void> => {
  const current = await orgRepo().findOne({ where: { id: organizationId } });
  if (!current) {
    throw new NotFoundError("Company not found");
  }
  await ensureOrganizationBillingCurrent(current);

  await AppDataSource.transaction(async (manager) => {
    const org = await manager.getRepository(Organization).findOne({
      where: { id: organizationId },
      lock: { mode: "pessimistic_write" },
    });
    if (!org) {
      throw new NotFoundError("Company not found");
    }

    const user = await manager.getRepository(User).findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundError("User not found");
    }
    const ownEmails = [...new Set([user.email.toLowerCase(), workEmail.toLowerCase()])];

    const seats = getPlanFeature(org, "team_members");
    if (seats?.kind === "metered" && seats.limit != null) {
      const members = await manager
        .getRepository(OrganizationMember)
        .count({ where: { organizationId } });
      const invites = await manager.getRepository(OrganizationInvite).find({
        where: { organizationId, status: OrganizationInviteStatus.Pending },
      });
      const heldForOthers = invites.filter(
        (invite) =>
          invite.expiresAt.getTime() >= Date.now() &&
          !ownEmails.includes(invite.email.toLowerCase())
      ).length;
      if (members + heldForOthers >= seats.limit) {
        throw new PlanLimitError(
          `Your company has reached its plan limit for ${seats.label ?? "team_members"} (${seats.limit}). Ask your organization owner to upgrade.`,
          "team_members",
          org.billingPlan
        );
      }
    }

    try {
      await manager.getRepository(OrganizationMember).insert({
        userId,
        organizationId,
        workEmail,
        role: "member",
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError("You are already a member of this company");
      }
      throw err;
    }

    await manager
      .getRepository(User)
      .update({ id: userId }, { activeOrganizationId: organizationId });
    await manager
      .getRepository(OrganizationInvite)
      .update(
        { organizationId, email: In(ownEmails), status: OrganizationInviteStatus.Pending },
        { status: OrganizationInviteStatus.Accepted }
      );

    if (onAdded) {
      await onAdded(manager);
    }
  });
};

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
  inviteeExists: boolean;
}

const validateEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export interface OrganizationPayload {
  name: string;
  domain?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  industry?: string | null;
  website?: string | null;
  facebook?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
}

export interface UpdateOrganizationPayload {
  name?: string;
  phone?: string | null;
  address?: string | null;
  industry?: string | null;
  facebook?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
  companyValues?: string | null;
  size?: string | null;
  about?: string | null;
  foundedYear?: number | null;
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
  canManagePeople: boolean;
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
  canManagePeople: member.canManagePeople,
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

const countPendingInvites = async (organizationId: string): Promise<number> => {
  const invites = await inviteRepo().find({
    where: {
      organizationId,
      status: OrganizationInviteStatus.Pending,
    },
  });
  return invites.filter((invite) => invite.expiresAt.getTime() >= Date.now()).length;
};

const assertCompanyAllowsJoinRequests = (org: Organization): void => {
  if (!org.domain && !org.email) {
    throw new ValidationError("This company cannot accept join requests");
  }
  const domainProbe = org.domain ? `placeholder@${org.domain}` : org.email!;
  if (isPublicEmailDomain(domainProbe)) {
    throw new ValidationError(
      "This company was registered with a personal email address. Only companies with a corporate work email domain accept team join requests."
    );
  }
};

const getOrganizationDomain = (org: Organization): string => {
  if (org.domain) return org.domain;
  if (org.email) return extractEmailDomain(org.email);
  throw new ValidationError("Company domain is not configured");
};

const assertRecruiterWorkEmailMatchesCompany = (org: Organization, workEmail: string): void => {
  if (isPublicEmailDomain(workEmail)) {
    throw new ValidationError(
      "Please use your corporate work email address (e.g. name@company.com), not a personal email."
    );
  }
  const companyDomain = getOrganizationDomain(org);
  if (isPublicEmailDomain(`placeholder@${companyDomain}`)) {
    throw new ValidationError("This company cannot accept team join requests");
  }
  const workDomain = extractEmailDomain(workEmail);
  if (workDomain !== companyDomain) {
    throw new ValidationError(
      `Your work email domain (@${workDomain}) must match this company's domain (@${companyDomain}).`
    );
  }
};

export const createOrganization = async (
  ownerId: string,
  payload: OrganizationPayload
): Promise<Organization> => {
  let domain: string | null = null;
  if (payload.domain?.trim()) {
    try {
      domain = normalizeCompanyDomain(payload.domain);
    } catch {
      throw new ValidationError("Domain must include a dot (e.g. acme.com)");
    }

    if (isPublicEmailDomain(`placeholder@${domain}`)) {
      throw new ValidationError(
        "Please use a corporate domain (e.g. acme.com), not a personal email provider."
      );
    }

    const domainExists = await orgRepo().findOne({ where: { domain } });
    if (domainExists) {
      throw new ConflictError("A company with this domain already exists");
    }

    const owner = await userRepo().findOne({ where: { id: ownerId } });
    if (!owner) {
      throw new NotFoundError("User not found");
    }
    if (!emailMatchesCompanyDomain(owner.email, domain)) {
      throw new ValidationError(
        `Your profile email must use the same domain as the company (@${domain}).`
      );
    }
  }

  if (!domain && !payload.linkedin?.trim()) {
    throw new ValidationError("LinkedIn URL is required when no company domain is provided");
  }
  if (payload.linkedin?.trim() && !isValidLinkedinUrl(payload.linkedin)) {
    throw new ValidationError(
      "Enter a valid LinkedIn URL (e.g. https://linkedin.com/company/acme)"
    );
  }

  if (!payload.email) {
    throw new ValidationError("Email is required");
  }
  if (!validateEmail(payload.email)) {
    throw new ValidationError("Invalid Email Address");
  }
  const email = payload.email.toLowerCase();

  if (domain && !emailMatchesCompanyDomain(email, domain)) {
    throw new ValidationError(`Contact email must use the company domain (@${domain}).`);
  }

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

  if (domain && isPublicEmailDomain(email)) {
    throw new ValidationError(
      "Please use a corporate work email address (e.g. name@company.com), not a personal email."
    );
  }

  if (domain && payload.website) {
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

  const { name, phone, address, industry, website, facebook, linkedin, twitter } = payload;
  const org = orgRepo().create({
    name,
    phone,
    address,
    industry,
    website,
    facebook,
    linkedin,
    twitter,
    email,
    domain,
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

  return orgRepo().findOneByOrFail({ id: saved.id });
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

  await addMemberWithSeat({
    organizationId: request.organizationId,
    userId: request.userId,
    workEmail: request.workEmail,
    onAdded: (manager) =>
      manager
        .getRepository(OrganizationJoinRequest)
        .update({ id: request.id }, { status: OrganizationJoinRequestStatus.Approved })
        .then(() => undefined),
  });

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

export const setMemberCanManagePeople = async (
  ownerId: string,
  organizationId: string,
  memberId: string,
  canManagePeople: boolean
): Promise<OrganizationMemberView> => {
  const org = await assertOwnership(ownerId, organizationId);

  const member = await memberRepo().findOne({
    where: { id: memberId, organizationId },
    relations: { user: true },
  });
  if (!member) {
    throw new NotFoundError("Member not found");
  }
  if (member.role === "owner" || member.userId === org.ownerId) {
    throw new ValidationError("The company owner always has access to People");
  }

  member.canManagePeople = canManagePeople;
  await memberRepo().save(member);
  return toMemberView(member);
};

export const updateOrganization = async (
  ownerId: string,
  organizationId: string,
  payload: UpdateOrganizationPayload
): Promise<Organization> => {
  const org = await assertOwnership(ownerId, organizationId);

  const {
    name,
    phone,
    address,
    industry,
    twitter,
    linkedin,
    facebook,
    companyValues,
    size,
    about,
    foundedYear,
  } = payload;
  const updates = Object.fromEntries(
    Object.entries({
      name,
      phone,
      address,
      industry,
      twitter,
      linkedin,
      facebook,
      companyValues,
      size,
      about,
      foundedYear,
    }).filter(([, value]) => value !== undefined)
  ) as UpdateOrganizationPayload & { legacyCompanyValues?: string[] };

  if (Object.keys(updates).length === 0) {
    return org;
  }

  if (updates.companyValues !== undefined) {
    updates.legacyCompanyValues = updates.companyValues ? [updates.companyValues] : [];
  }

  if (updates.phone) {
    const phoneOwner = await orgRepo().findOne({ where: { phone: updates.phone } });
    if (phoneOwner && phoneOwner.id !== org.id) {
      throw new ConflictError("Another company is already registered with this phone number");
    }
  }

  await orgRepo().update(org.id, updates);
  return orgRepo().findOneByOrFail({ id: org.id });
};

export const deleteOrganization = async (
  ownerId: string,
  organizationId: string
): Promise<void> => {
  const org = await assertOwnership(ownerId, organizationId);

  const evidence = await evidenceKeysFor({ organizationId });
  const chargeableSubscriptions = await AppDataSource.transaction((manager) =>
    purgeOrganizationCascade(manager, organizationId)
  );

  // Only clean up the logo and Paystack once the delete itself has actually
  // committed — otherwise a failed/rolled-back delete would leave a
  // still-referenced logo deleted from Spaces or a live plan cancelled.
  await disablePaystackSubscriptions(chargeableSubscriptions);
  await deleteSpacesObjectQuietly(org.logoKey, organizationId);
  await deleteEvidenceQuietly(evidence);
};

export const updateLogo = async (
  ownerId: string,
  organizationId: string,
  file?: Express.Multer.File
): Promise<Organization> => {
  if (!file) {
    throw new ValidationError("No image file was provided");
  }
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    throw new ValidationError("Unsupported image file type");
  }
  if (file.size === 0) {
    throw new ValidationError("File is empty");
  }

  const org = await assertOwnership(ownerId, organizationId);

  // Upload before saving so a Spaces failure throws here, leaving the
  // company's existing logo (if any) in place rather than clearing it.
  const key = spacesKeyFor("logos", organizationId, file.originalname);
  const logoUrl = await uploadToSpaces(file.buffer, key, file.mimetype);

  const previousKey = org.logoKey;
  const saved = await orgRepo().save({ ...org, logoUrl, logoKey: key });

  await deleteSpacesObjectQuietly(previousKey, organizationId);

  return saved;
};

export const removeLogo = async (
  ownerId: string,
  organizationId: string
): Promise<Organization> => {
  const org = await assertOwnership(ownerId, organizationId);

  if (!org.logoKey) {
    return org;
  }

  const previousKey = org.logoKey;
  const saved = await orgRepo().save({ ...org, logoUrl: null, logoKey: null });

  await deleteSpacesObjectQuietly(previousKey, organizationId);

  return saved;
};

export const generateInviteToken = (): string => crypto.randomBytes(32).toString("hex");

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
  // Load the invite first, then the company. `relations: { organization: true }`
  // uses an inner join, so a metadata/join mismatch returns null and the
  // public preview/accept routes 404 even though the token row exists.
  const invite = await inviteRepo().findOne({ where: { token: token.trim() } });
  if (!invite) return null;

  const organization = await orgRepo().findOne({ where: { id: invite.organizationId } });
  if (!organization) return null;

  invite.organization = organization;
  return invite;
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
  await assertCompanyHasOpenSeat(org.id);

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

  const existingUser = await userRepo().findOne({ where: { email: invite.email } });

  return {
    organizationName: invite.organization.name,
    invitedEmail: invite.email,
    status,
    expiresAt: invite.expiresAt,
    inviteeExists: !!existingUser,
  };
};

export const acceptPendingInviteForUser = async (
  userId: string
): Promise<{ joinedCompanyName: string } | null> => {
  const user = await userRepo().findOne({ where: { id: userId } });
  if (!user || user.userRole !== UserRole.Recruiter) return null;

  const invite = await inviteRepo().findOne({
    where: {
      email: user.email.toLowerCase(),
      status: OrganizationInviteStatus.Pending,
    },
    relations: { organization: true },
    order: { createdAt: "DESC" },
  });

  if (!invite || resolveInviteStatus(invite) !== OrganizationInviteStatus.Pending) {
    return null;
  }

  try {
    await acceptOrganizationInvite(userId, invite.token);
    return { joinedCompanyName: invite.organization.name };
  } catch (err) {
    logger.error(`Auto-accept invite failed for user ${userId}: ${(err as Error).message}`);
    return null;
  }
};

export const acceptOrganizationInvite = async (
  userId: string,
  token: string
): Promise<Organization> => {
  const invite = await findInviteByToken(token);
  if (!invite) {
    throw new NotFoundError("Invite not found");
  }

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

  const existingMember = await memberRepo().findOne({
    where: { userId, organizationId: invite.organizationId },
  });
  if (existingMember) {
    if (invite.status === OrganizationInviteStatus.Pending) {
      invite.status = OrganizationInviteStatus.Accepted;
      await inviteRepo().save(invite);
    }
    return invite.organization;
  }

  assertInviteUsable(invite);

  assertCompanyAllowsJoinRequests(invite.organization);
  assertRecruiterWorkEmailMatchesCompany(invite.organization, invite.email);

  await addMemberWithSeat({
    organizationId: invite.organizationId,
    userId,
    workEmail: invite.email,
  });

  return invite.organization;
};

const ACCESS_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ACCESS_CODE_LENGTH = 8;
const ACCESS_CODE_ATTEMPTS = 5;
const ACCESS_CODE_MISS = "That code doesn't match a company. Check it with your company owner.";

const generateAccessCode = (): string => {
  const chars = Array.from(
    { length: ACCESS_CODE_LENGTH },
    () => ACCESS_CODE_ALPHABET[crypto.randomInt(ACCESS_CODE_ALPHABET.length)]
  ).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
};

/** Accepts any case, spaces and dashes. Returns the stored XXXX-XXXX form, or null. */
export const normalizeAccessCode = (input: unknown): string | null => {
  if (typeof input !== "string") return null;
  const chars = input.toUpperCase().replace(/[\s-]/g, "");
  if (chars.length !== ACCESS_CODE_LENGTH) return null;
  if ([...chars].some((char) => !ACCESS_CODE_ALPHABET.includes(char))) return null;
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
};

const readAccessCode = async (organizationId: string): Promise<string | null> => {
  const row = await orgRepo().findOne({
    where: { id: organizationId },
    select: { id: true, accessCode: true },
  });
  return row?.accessCode ?? null;
};

export const getOrganizationAccessCode = async (
  ownerId: string,
  organizationId: string
): Promise<{ code: string | null }> => {
  await assertOwnership(ownerId, organizationId);
  return { code: await readAccessCode(organizationId) };
};

/** Creates the company's code, or replaces it. A replaced code stops working at once. */
export const rotateOrganizationAccessCode = async (
  ownerId: string,
  organizationId: string
): Promise<{ code: string }> => {
  const org = await assertOwnership(ownerId, organizationId);
  if (org.status !== OrganizationStatus.Verified) {
    throw new ValidationError("Access codes are available once your company is verified.");
  }
  assertCompanyAllowsJoinRequests(org);
  await assertCompanyHasOpenSeat(org.id);

  for (let attempt = 0; attempt < ACCESS_CODE_ATTEMPTS; attempt += 1) {
    const code = generateAccessCode();
    try {
      await orgRepo().update({ id: org.id }, { accessCode: code });
      return { code };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("Could not create a unique access code");
};

export const disableOrganizationAccessCode = async (
  ownerId: string,
  organizationId: string
): Promise<void> => {
  await assertOwnership(ownerId, organizationId);
  await orgRepo().update({ id: organizationId }, { accessCode: null });
};

export const joinOrganizationWithAccessCode = async (
  userId: string,
  rawCode: unknown
): Promise<{ organizationId: string; organizationName: string }> => {
  const code = normalizeAccessCode(rawCode);
  const org = code ? await orgRepo().findOne({ where: { accessCode: code } }) : null;
  if (!org) {
    throw new NotFoundError(ACCESS_CODE_MISS);
  }

  const user = await userRepo().findOne({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError("User not found");
  }
  if (user.userRole !== UserRole.Recruiter) {
    throw new AuthorizationError("Only recruiters can join a company");
  }
  if (org.status !== OrganizationStatus.Verified) {
    throw new ValidationError(
      "This company isn't verified yet. Try again once AuxHR has verified it."
    );
  }
  if (org.ownerId === userId) {
    throw new ConflictError("You are the owner of this company");
  }
  const existingMember = await memberRepo().findOne({
    where: { userId, organizationId: org.id },
  });
  if (existingMember) {
    throw new ConflictError("You are already a member of this company");
  }

  try {
    assertCompanyAllowsJoinRequests(org);
    assertRecruiterWorkEmailMatchesCompany(org, user.email);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new ValidationError(
        "Your account email must use your company's work email domain to join with a code. Ask your company owner for an email invite instead."
      );
    }
    throw err;
  }

  await addMemberWithSeat({ organizationId: org.id, userId, workEmail: user.email });

  if (org.ownerId) {
    const name = `${user.firstName} ${user.lastName}`.trim() || "A recruiter";
    try {
      await createNotification(
        org.ownerId,
        `${name} joined ${org.name} with your access code.`,
        "New teammate joined"
      );
    } catch (err) {
      logger.error(
        `Access code join notification failed for owner ${org.ownerId}: ${(err as Error).message}`
      );
    }
  }

  return { organizationId: org.id, organizationName: org.name };
};
