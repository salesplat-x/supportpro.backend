import { EntityManager } from "typeorm";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { Notification } from "../entities/Notification.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { OrganizationOwnershipTransfer } from "../entities/OrganizationOwnershipTransfer.js";
import { Subscription } from "../entities/Subscription.js";
import { User } from "../entities/User.js";
import { SubscriptionStatus, UserRole } from "../types/enums.js";
import { ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import EmailService from "../utils/integrations/email/emailService.js";
import logger from "../utils/logger.js";
import { fullNameOf } from "./staffRecord.js";

const NOTIFICATION_TYPE = "ownership_changed";
const COMPANY_LINK = "/recruiterDashboard/company";

export interface OwnershipTransferView {
  id: string;
  fromName: string;
  toName: string;
  reason: string;
  createdAt: Date;
}

const toView = (row: OrganizationOwnershipTransfer): OwnershipTransferView => ({
  id: row.id,
  fromName: row.fromName,
  toName: row.toName,
  reason: row.reason,
  createdAt: row.createdAt,
});

export const listOwnershipTransfers = async (
  organizationId: string
): Promise<OwnershipTransferView[]> => {
  const rows = await AppDataSource.getRepository(OrganizationOwnershipTransfer).find({
    where: { organizationId },
    order: { createdAt: "DESC" },
  });
  return rows.map(toView);
};

export const activeSubscriptionSummary = async (
  organizationId: string
): Promise<{ planName: string | null; nextPaymentDate: Date | null } | null> => {
  const subscription = await AppDataSource.getRepository(Subscription).findOne({
    where: { organizationId, status: SubscriptionStatus.Active },
    relations: { plan: true },
    order: { createdAt: "DESC" },
  });
  return subscription
    ? {
        planName: subscription.plan?.name ?? null,
        nextPaymentDate: subscription.nextPaymentDate,
      }
    : null;
};

/**
 * Deleting a recruiter deletes what they hold (`purgeRecruiterCascade`). Changing a creator is
 * often followed by removing the person who left, so the company's records move to the new one.
 */
const moveCompanyRecords = async (
  em: EntityManager,
  organizationId: string,
  fromUserId: string,
  toUserId: string
): Promise<void> => {
  const params = [toUserId, organizationId, fromUserId];
  await em.query(
    `UPDATE subscriptions SET user_id = $1 WHERE organization_id = $2 AND user_id = $3`,
    params
  );
  await em.query(
    `UPDATE payments SET user_id = $1 WHERE organization_id = $2 AND user_id = $3`,
    params
  );
  await em.query(
    `UPDATE applications a SET recruiter_id = $1
     FROM jobs j
     WHERE a.job_id = j.id AND j.organization_id = $2 AND a.recruiter_id = $3`,
    params
  );
  await em.query(
    `UPDATE jobs SET posted_by_id = $1 WHERE organization_id = $2 AND posted_by_id = $3`,
    params
  );
  await em.query(
    `UPDATE ai_configs SET recruiter_id = $1 WHERE organization_id = $2 AND recruiter_id = $3`,
    params
  );
  await em.query(
    `UPDATE scouts s SET recruiter_id = $1
     FROM scout_jobs j
     WHERE s.scout_job_id = j.id AND j.organization_id = $2 AND s.recruiter_id = $3`,
    params
  );
  await em.query(
    `UPDATE scout_runs r SET recruiter_id = $1
     FROM scout_jobs j
     WHERE r.scout_job_id = j.id AND j.organization_id = $2 AND r.recruiter_id = $3`,
    params
  );
  await em.query(
    `UPDATE scout_jobs SET posted_by_id = $1 WHERE organization_id = $2 AND posted_by_id = $3`,
    params
  );
};

export const changeOrganizationOwner = async (
  adminId: string,
  organizationId: string,
  input: { newOwnerUserId: string; reason: string }
): Promise<OwnershipTransferView> => {
  const result = await AppDataSource.transaction(async (em) => {
    const organization = await em.getRepository(Organization).findOne({
      where: { id: organizationId },
      lock: { mode: "pessimistic_write" },
    });
    if (!organization) {
      throw new NotFoundError("Company not found");
    }
    if (organization.ownerId === input.newOwnerUserId) {
      throw new ConflictError("This person is already the company's creator");
    }

    const members = em.getRepository(OrganizationMember);
    const newOwnerRow = await members.findOne({
      where: { userId: input.newOwnerUserId, organizationId },
      lock: { mode: "pessimistic_write" },
    });
    if (!newOwnerRow) {
      throw new NotFoundError("This person isn't on the company's team");
    }
    const newOwner = await em.getRepository(User).findOneOrFail({
      where: { id: input.newOwnerUserId },
    });
    if (newOwner.userRole !== UserRole.Recruiter) {
      throw new ValidationError("Only a recruiter account can be a company's creator");
    }
    if (!newOwner.active || !newOwner.emailVerifiedAt) {
      throw new ValidationError("This person's account must be active with a verified email");
    }

    const previousOwnerId = organization.ownerId;
    const previousOwner = previousOwnerId
      ? await em.getRepository(User).findOne({ where: { id: previousOwnerId } })
      : null;

    await em.getRepository(Organization).update(organization.id, { ownerId: newOwner.id });
    await members.update(newOwnerRow.id, { role: "owner" });
    if (previousOwner) {
      const previousRow = await members.findOne({
        where: { userId: previousOwner.id, organizationId },
      });
      if (previousRow) {
        await members.update(previousRow.id, { role: "member", canManagePeople: false });
      } else {
        await members.insert({
          userId: previousOwner.id,
          organizationId,
          workEmail: previousOwner.email,
          role: "member",
          canManagePeople: false,
        });
      }
      await moveCompanyRecords(em, organizationId, previousOwner.id, newOwner.id);
    }

    const transfers = em.getRepository(OrganizationOwnershipTransfer);
    const transfer = await transfers.save(
      transfers.create({
        organizationId,
        fromUserId: previousOwner?.id ?? null,
        toUserId: newOwner.id,
        adminId,
        fromName: previousOwner ? fullNameOf(previousOwner) : "No one",
        toName: fullNameOf(newOwner),
        reason: input.reason,
      })
    );

    const notifications = em.getRepository(Notification);
    await notifications.save(
      [
        {
          userId: newOwner.id,
          message: `You're now the creator of ${organization.name}.`,
        },
        ...(previousOwner
          ? [
              {
                userId: previousOwner.id,
                message: `${fullNameOf(newOwner)} is now the creator of ${organization.name}. You're still on the team.`,
              },
            ]
          : []),
      ].map((notice) =>
        notifications.create({
          ...notice,
          title: "Company creator changed",
          type: NOTIFICATION_TYPE,
          link: COMPANY_LINK,
          organizationId,
        })
      )
    );

    return { transfer, organization, newOwner, previousOwner };
  });

  await emailBothPeople(result.organization, result.newOwner, result.previousOwner);
  return toView(result.transfer);
};

const emailBothPeople = async (
  organization: Organization,
  newOwner: User,
  previousOwner: User | null
): Promise<void> => {
  const subscription = await activeSubscriptionSummary(organization.id);
  const ctaUrl = `${env.website ?? ""}${COMPANY_LINK}`;
  const email = new EmailService();
  const send = (to: string, subject: string, paragraphs: string[]) =>
    email
      .sendPeopleUpdate({ to, subject, paragraphs, ctaLabel: "Open your company", ctaUrl })
      .catch((err: Error) =>
        logger.error(`Creator change email for ${organization.id} failed: ${err.message}`)
      );

  await send(newOwner.email, `You're now the creator of ${organization.name}`, [
    `An Auxhr admin made you the creator of ${organization.name}.`,
    "You can now see your employees' pay, benefits and contracts, and you manage the company's team and plan.",
    ...(subscription
      ? [
          "The company's plan is still being paid by the previous creator's card. Buy the plan yourself to move it to your card, and we'll cancel the old payment.",
        ]
      : []),
  ]);
  if (previousOwner) {
    await send(previousOwner.email, `${organization.name} has a new creator`, [
      `An Auxhr admin made ${fullNameOf(newOwner)} the creator of ${organization.name}. You're still on the team.`,
      "You can no longer see pay, benefits or contracts for this company.",
      ...(subscription
        ? [
            "Your card keeps paying for the company's plan until the new creator buys it or an admin cancels it. Contact support if you need it stopped.",
          ]
        : []),
    ]);
  }
};
