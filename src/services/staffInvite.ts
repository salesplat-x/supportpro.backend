import crypto from "node:crypto";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
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
import { getProfileCompletion } from "./user.js";

const DAY_MS = 86_400_000;
const INVITE_RESEND_COOLDOWN_MS = 60_000;
const EMAIL_TIMEOUT_MS = 10_000;

const userRepo = () => AppDataSource.getRepository(User);
const memberRepo = () => AppDataSource.getRepository(OrganizationMember);

export type StaffInvitePreview =
  | { status: "expired" | "accepted" }
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
}

const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

export const assertCanInvite = async (org: Organization, email: string): Promise<void> => {
  if (org.status === OrganizationStatus.Rejected) {
    throw new AuthorizationError("This company can't send invites right now");
  }

  const account = await userRepo().findOne({ where: { email }, select: { id: true } });
  const accountOnTeam =
    !!account &&
    (org.ownerId === account.id ||
      (await memberRepo().exists({ where: { userId: account.id, organizationId: org.id } })));
  const workEmailOnTeam =
    !accountOnTeam &&
    (await memberRepo()
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

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The email provider did not respond")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
    await assertCanInvite(org, current.email);

    const resend = !!current.inviteTokenHash;
    const issued = issueInvite(current, actor);
    const saved = await em.getRepository(StaffMember).save(current);
    await recordActivities(em, saved, [
      activityEntry(resend ? StaffActivityType.InviteResent : StaffActivityType.Invited, actor),
    ]);
    return { staff: saved, token: issued };
  });

  const inviteEmailSent = await sendInviteEmail(org, staff, token, actor);
  return { staff: await viewOf(staff), inviteEmailSent };
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
  if (state !== "pending") return { status: "expired" };

  const [org, account] = await Promise.all([
    AppDataSource.getRepository(Organization).findOneOrFail({
      where: { id: staff.organizationId },
    }),
    userRepo().findOne({ where: { email: staff.email }, select: { id: true } }),
  ]);

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

/**
 * The only place a staff record is linked to an account, and it re-checks
 * everything the join wizard promised: talent account, matching verified email,
 * complete profile.
 */
export const acceptStaffInvite = async (userId: string, token: string): Promise<JoinedStaff> => {
  const user = await userRepo().findOne({ where: { id: userId }, relations: { userRoles: true } });
  if (!user) {
    throw new NotFoundError("User not found");
  }
  if (user.userRole !== UserRole.Talent) {
    throw new AuthorizationError("Join with a personal AuxHR account, not a recruiter account");
  }
  if (!user.emailVerifiedAt) {
    throw new AuthorizationError("Verify your email address before joining");
  }

  return AppDataSource.transaction(async (em) => {
    const staff = await em.getRepository(StaffMember).findOne({
      where: { inviteTokenHash: hashToken(token) },
      lock: { mode: "pessimistic_write" },
    });
    if (!staff) {
      throw new NotFoundError("Invite not found");
    }
    if (user.email.toLowerCase() !== staff.email) {
      throw new AuthorizationError("Sign in with the email address this invite was sent to");
    }
    const org = await em
      .getRepository(Organization)
      .findOneOrFail({ where: { id: staff.organizationId } });
    const joined = (joinedAt: Date): JoinedStaff => ({
      organizationName: org.name,
      jobTitle: staff.jobTitle,
      joinedAt,
    });

    if (staff.userId) {
      if (staff.userId === user.id && staff.joinedAt) return joined(staff.joinedAt);
      throw new ValidationError("This invite has already been used");
    }
    if (inviteStateOf(staff) === "expired") {
      throw new ValidationError("This invite has expired");
    }
    if (!getProfileCompletion(user).isProfileComplete) {
      throw new AppError(
        422,
        "PROFILE_INCOMPLETE",
        "Complete your profile before joining this company"
      );
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
    return joined(staff.joinedAt);
  });
};
