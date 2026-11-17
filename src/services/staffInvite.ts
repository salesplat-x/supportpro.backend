import crypto from "node:crypto";
import { EntityManager, In, IsNull, Not } from "typeorm";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { PayPackage } from "../entities/PayPackage.js";
import { ShareGrant } from "../entities/ShareGrant.js";
import { StaffChecklistTask } from "../entities/StaffChecklistTask.js";
import { DocumentStatus, StaffDocument } from "../entities/StaffDocument.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { StaffMember, StaffStatus } from "../entities/StaffMember.js";
import { User } from "../entities/User.js";
import { OrganizationStatus, UserRole } from "../types/enums.js";
import {
  AppError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errors";
import EmailService from "../utils/integrations/email/emailService.js";
import logger from "../utils/logger.js";
import { generateHashedPassword, signToken } from "../utils/crypto.js";
import { INVITE_EXPIRY_DAYS, generateInviteToken } from "./organization.js";
import { assertCanManagePeople } from "./peopleAccess.js";
import { activityEntry, recordActivities } from "./staffAudit.js";
import {
  Actor,
  StaffView,
  findStaff,
  fullNameOf,
  inviteStateOf,
  isUniqueViolation,
  viewOf,
} from "./staffRecord.js";
import { notifyTalent, TALENT_NOTIFICATION } from "./talentNotifications.js";

const DAY_MS = 86_400_000;
const INVITE_RESEND_COOLDOWN_MS = 60_000;
const EMAIL_TIMEOUT_MS = 10_000;

const userRepo = () => AppDataSource.getRepository(User);

export type StaffInvitePreview =
  | { status: "accepted" }
  | {
      status: "expired";
      organizationName: string;
      organizationLogoUrl: string | null;
      invitedEmail: string;
      invitedAt: Date | null;
      expiresAt: Date | null;
      contactEmail: string | null;
    }
  | {
      status: "pending";
      organizationName: string;
      organizationLogoUrl: string | null;
      jobTitle: string;
      invitedEmail: string;
      invitedByName: string | null;
      expiresAt: Date | null;
      inviteeExists: boolean;
    };

export interface JoinedStaff {
  organizationName: string;
  jobTitle: string;
  joinedAt: Date;
  documentsToSign: number;
  openTasks: number;
  hasPay: boolean;
  hasShareOptions: boolean;
}

export interface PasswordJoin {
  user: Omit<User, "password">;
  token: string;
  joined: JoinedStaff;
}

export const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

export const assertCanInvite = async (
  org: Organization,
  email: string,
  em: EntityManager = AppDataSource.manager
): Promise<void> => {
  if (org.status === OrganizationStatus.Rejected) {
    throw new AuthorizationError("This company can't send invites right now");
  }

  const members = em.getRepository(OrganizationMember);
  const account = await em.getRepository(User).findOne({ where: { email }, select: { id: true } });
  const accountOnTeam =
    !!account &&
    (org.ownerId === account.id ||
      (await members.exists({ where: { userId: account.id, organizationId: org.id } })));
  const workEmailOnTeam =
    !accountOnTeam &&
    (await members
      .createQueryBuilder("member")
      .where("member.organizationId = :organizationId", { organizationId: org.id })
      .andWhere("LOWER(member.workEmail) = :email", { email })
      .getExists());

  if (accountOnTeam || workEmailOnTeam) {
    throw new ConflictError(
      "This person is already on your company team and can't be invited as staff"
    );
  }
};

/** Replaces any earlier invite, so only the newest link works. Returns the raw token to email. */
export const issueInvite = (staff: StaffMember, actor: Actor): string => {
  const token = generateInviteToken();
  staff.inviteTokenHash = hashToken(token);
  staff.inviteExpiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * DAY_MS);
  staff.inviteOpenedAt = null;
  staff.invitedAt = new Date();
  staff.invitedById = actor.id;
  staff.invitedByName = fullNameOf(actor);
  staff.joinedAt = null;
  return token;
};

export const withTimeout = async <T>(
  work: Promise<T>,
  ms: number,
  message = "The email provider did not respond"
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Tells an invitee who already has an AuxHR account; never throws. */
export const notifyInvitedTalent = async (org: Organization, staff: StaffMember): Promise<void> => {
  const account = await userRepo()
    .findOne({ where: { email: staff.email, userRole: UserRole.Talent }, select: { id: true } })
    .catch(() => null);
  if (account) {
    await notifyTalent({
      userId: account.id,
      type: TALENT_NOTIFICATION.StaffInvite,
      title: `${org.name} added you as staff`,
      message: "Accept to see your contracts, pay and first-week tasks",
      link: "/talentDashboard/my-work",
      dedupeKey: `staff_invite:${staff.id}`,
    });
  }
};

/** Never throws: a failed email is recorded on the timeline so HR can resend. */
export const sendInviteEmail = async (
  org: Organization,
  staff: StaffMember,
  token: string,
  actor: Actor
): Promise<boolean> => {
  try {
    if (!env.website) {
      throw new Error("FRONTEND_CALLBACK_URL is not configured");
    }
    await withTimeout(
      new EmailService().sendStaffInvite({
        email: staff.email,
        firstName: staff.fullName.split(" ")[0] ?? staff.fullName,
        companyName: org.name,
        companyLogoUrl: org.logoUrl,
        inviterName: fullNameOf(actor),
        jobTitle: staff.jobTitle,
        inviteLink: `${env.website}/join-staff/${token}`,
      }),
      EMAIL_TIMEOUT_MS
    );
    return true;
  } catch (err) {
    logger.error(`Staff invite email failed for staff ${staff.id}: ${(err as Error).message}`);
    try {
      await recordActivities(AppDataSource.manager, staff, [
        activityEntry(StaffActivityType.InviteFailed, actor, { reason: "email_not_sent" }),
      ]);
    } catch (recordErr) {
      logger.error(
        `Could not record the failed invite email for staff ${staff.id}: ${(recordErr as Error).message}`
      );
    }
    return false;
  }
};

export const inviteStaff = async (
  actor: User,
  organizationId: string,
  staffId: string
): Promise<{ staff: StaffView; inviteEmailSent: boolean }> => {
  const org = await assertCanManagePeople(actor.id, organizationId);

  const { staff, token } = await AppDataSource.transaction(async (em) => {
    const current = await findStaff(organizationId, staffId, { em, lock: true });
    if (current.status === StaffStatus.Ended) {
      throw new ConflictError("This employment has ended");
    }
    if (current.userId) {
      throw new ConflictError("This person has already joined");
    }
    if (current.invitedAt && Date.now() - current.invitedAt.getTime() < INVITE_RESEND_COOLDOWN_MS) {
      throw new AppError(429, "RATE_LIMITED", "Wait a minute before resending this invite");
    }
    await assertCanInvite(org, current.email, em);

    const resend = !!current.inviteTokenHash;
    const issued = issueInvite(current, actor);
    const saved = await em.getRepository(StaffMember).save(current);
    await recordActivities(em, saved, [
      activityEntry(resend ? StaffActivityType.InviteResent : StaffActivityType.Invited, actor),
    ]);
    return { staff: saved, token: issued };
  });

  const inviteEmailSent = await sendInviteEmail(org, staff, token, actor);
  await notifyInvitedTalent(org, staff);
  return { staff: await viewOf(staff), inviteEmailSent };
};

const contactEmailFor = async (org: Organization, staff: StaffMember): Promise<string | null> => {
  const ids = [staff.invitedById, org.ownerId].filter((id): id is string => !!id);
  if (ids.length === 0) return null;
  const users = await userRepo().find({
    where: { id: In(ids) },
    select: { id: true, email: true },
  });
  const byId = new Map(users.map((u) => [u.id, u.email]));
  return ids.map((id) => byId.get(id)).find((email): email is string => !!email) ?? null;
};

export const previewStaffInvite = async (token: string): Promise<StaffInvitePreview> => {
  const staff = await AppDataSource.getRepository(StaffMember).findOne({
    where: { inviteTokenHash: hashToken(token) },
  });
  if (!staff) {
    throw new NotFoundError("Invite not found");
  }
  const state = inviteStateOf(staff);
  if (state === "accepted") return { status: "accepted" };

  const org = await AppDataSource.getRepository(Organization).findOneOrFail({
    where: { id: staff.organizationId },
  });
  if (state !== "pending") {
    return {
      status: "expired",
      organizationName: org.name,
      organizationLogoUrl: org.logoUrl,
      invitedEmail: staff.email,
      invitedAt: staff.invitedAt,
      expiresAt: staff.inviteExpiresAt,
      contactEmail: await contactEmailFor(org, staff),
    };
  }

  const account = await userRepo().findOne({
    where: { email: staff.email },
    select: { id: true },
  });

  await AppDataSource.transaction(async (em) => {
    const opened = await em
      .createQueryBuilder()
      .update(StaffMember)
      .set({ inviteOpenedAt: new Date() })
      .where(`"id" = :id AND "invite_opened_at" IS NULL`, { id: staff.id })
      .execute();
    if (opened.affected) {
      await recordActivities(em, staff, [
        { type: StaffActivityType.InviteOpened, actorId: null, actorName: staff.fullName },
      ]);
    }
  });

  return {
    status: "pending",
    organizationName: org.name,
    organizationLogoUrl: org.logoUrl,
    jobTitle: staff.jobTitle,
    invitedEmail: staff.email,
    invitedByName: staff.invitedByName,
    expiresAt: staff.inviteExpiresAt,
    inviteeExists: !!account,
  };
};

const joinedSummary = async (
  em: EntityManager,
  org: Organization,
  staff: StaffMember
): Promise<JoinedStaff> => {
  const [documentsToSign, openTasks, hasPay, hasShareOptions] = await Promise.all([
    em.getRepository(StaffDocument).count({
      where: { staffId: staff.id, status: DocumentStatus.Sent },
    }),
    em.getRepository(StaffChecklistTask).count({ where: { staffId: staff.id, doneAt: IsNull() } }),
    em.getRepository(PayPackage).exists({ where: { staffId: staff.id } }),
    em.getRepository(ShareGrant).exists({ where: { staffId: staff.id } }),
  ]);
  return {
    organizationName: org.name,
    jobTitle: staff.jobTitle,
    joinedAt: staff.joinedAt!,
    documentsToSign,
    openTasks,
    hasPay,
    hasShareOptions,
  };
};

/** Links a pending invite to the account inside the caller's transaction. */
const linkStaff = async (
  em: EntityManager,
  staff: StaffMember,
  user: User
): Promise<JoinedStaff> => {
  const org = await em
    .getRepository(Organization)
    .findOneOrFail({ where: { id: staff.organizationId } });

  if (staff.userId) {
    if (staff.userId === user.id && staff.joinedAt) return joinedSummary(em, org, staff);
    throw new ValidationError("This invite has already been used");
  }
  if (inviteStateOf(staff) === "expired") {
    throw new ValidationError("This invite has expired");
  }

  staff.userId = user.id;
  staff.joinedAt = new Date();
  staff.status = StaffStatus.Active;
  try {
    await em.getRepository(StaffMember).save(staff);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("This account is already linked to a staff record at this company");
    }
    throw err;
  }
  await recordActivities(em, staff, [activityEntry(StaffActivityType.Joined, user)]);
  return joinedSummary(em, org, staff);
};

/**
 * Links an existing account to a staff record. The emailed token proves the
 * inbox, so that path also verifies the account; the in-app path needs a
 * verified email already.
 */
const joinStaff = async (
  userId: string,
  findStaff: (em: EntityManager, user: User) => Promise<StaffMember | null>,
  tokenProvesEmail: boolean
): Promise<JoinedStaff> => {
  const user = await userRepo().findOne({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError("User not found");
  }
  if (user.userRole !== UserRole.Talent) {
    throw new AuthorizationError("Join with a personal AuxHR account, not a recruiter account");
  }
  if (!user.emailVerifiedAt && !tokenProvesEmail) {
    throw new AuthorizationError("Verify your email address before joining");
  }

  return AppDataSource.transaction(async (em) => {
    const staff = await findStaff(em, user);
    if (!staff || inviteStateOf(staff) === "none") {
      throw new NotFoundError("Invite not found");
    }
    if (user.email.toLowerCase() !== staff.email) {
      throw new AuthorizationError("Sign in with the email address this invite was sent to");
    }
    const joined = await linkStaff(em, staff, user);
    if (!user.emailVerifiedAt) {
      await em
        .createQueryBuilder()
        .update(User)
        .set({ emailVerifiedAt: () => "now()" })
        .where(`"id" = :id AND "emailVerifiedAt" IS NULL`, { id: user.id })
        .execute();
    }
    return joined;
  });
};

const splitName = (fullName: string): { firstName: string; lastName: string } => {
  const words = fullName.trim().split(/\s+/);
  const firstName = words[0] ?? fullName;
  return { firstName, lastName: words.slice(1).join(" ") || firstName };
};

/**
 * Creates a talent account for someone who has none yet and joins them in one
 * transaction, so a failed join never leaves an account behind.
 */
export const joinWithPassword = async (token: string, password: string): Promise<PasswordJoin> => {
  const hashedPassword = await generateHashedPassword(password);

  const { user, joined } = await AppDataSource.transaction(async (em) => {
    const staff = await em.getRepository(StaffMember).findOne({
      where: { inviteTokenHash: hashToken(token) },
      lock: { mode: "pessimistic_write" },
    });
    const state = staff ? inviteStateOf(staff) : "none";
    if (!staff || state === "none") {
      throw new NotFoundError("Invite not found");
    }
    const accountExists = () =>
      new AppError(409, "ACCOUNT_EXISTS", "You already have an AuxHR account. Log in to join.");
    if (state === "accepted") {
      throw accountExists();
    }
    if (state === "expired") {
      throw new ValidationError("This invite has expired");
    }
    if (await em.getRepository(User).exists({ where: { email: staff.email } })) {
      throw accountExists();
    }

    const users = em.getRepository(User);
    let created: User;
    try {
      created = await users.save(
        users.create({
          ...splitName(staff.fullName),
          email: staff.email,
          password: hashedPassword,
          userRole: UserRole.Talent,
          roleChangeCount: 0,
          emailVerifiedAt: new Date(),
        })
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw accountExists();
      throw err;
    }
    return { user: created, joined: await linkStaff(em, staff, created) };
  });

  logger.info(`User registered from staff invite: id=${user.id}`);
  const { password: _password, ...safeUser } = user;
  return { user: safeUser, token: signToken(user), joined };
};

export const acceptStaffInvite = (userId: string, token: string): Promise<JoinedStaff> =>
  joinStaff(
    userId,
    (em) =>
      em.getRepository(StaffMember).findOne({
        where: { inviteTokenHash: hashToken(token) },
        lock: { mode: "pessimistic_write" },
      }),
    true
  );

/** Accepts a pending invite from My work; only invites sent to the user's own email are found. */
export const acceptMyStaffInvite = (userId: string, staffId: string): Promise<JoinedStaff> =>
  joinStaff(
    userId,
    (em, user) =>
      em.getRepository(StaffMember).findOne({
        where: { id: staffId, email: user.email.toLowerCase() },
        lock: { mode: "pessimistic_write" },
      }),
    false
  );

export interface MyStaffInvite {
  id: string;
  organizationName: string;
  organizationLogoUrl: string | null;
  jobTitle: string | null;
  invitedByName: string | null;
  expiresAt: Date | null;
}

export const listMyStaffInvites = async (userId: string): Promise<MyStaffInvite[]> => {
  const user = await userRepo().findOne({
    where: { id: userId },
    select: { id: true, email: true, emailVerifiedAt: true, userRole: true },
  });
  if (!user || user.userRole !== UserRole.Talent || !user.emailVerifiedAt) return [];
  const invites = (
    await AppDataSource.getRepository(StaffMember).find({
      where: {
        email: user.email.toLowerCase(),
        userId: IsNull(),
        inviteTokenHash: Not(IsNull()),
        status: Not(StaffStatus.Ended),
      },
      order: { invitedAt: "DESC" },
    })
  ).filter((staff) => inviteStateOf(staff) === "pending");
  if (invites.length === 0) return [];
  const orgs = await AppDataSource.getRepository(Organization).find({
    where: { id: In(invites.map((staff) => staff.organizationId)) },
    select: { id: true, name: true, logoUrl: true },
  });
  const orgById = new Map(orgs.map((org) => [org.id, org]));
  return invites.flatMap((staff) => {
    const org = orgById.get(staff.organizationId);
    return org
      ? [
          {
            id: staff.id,
            organizationName: org.name,
            organizationLogoUrl: org.logoUrl ?? null,
            jobTitle: staff.jobTitle ?? null,
            invitedByName: staff.invitedByName ?? null,
            expiresAt: staff.inviteExpiresAt,
          },
        ]
      : [];
  });
};
