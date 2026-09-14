import {
  In,
  type DataSource,
  type EntityManager,
  type EntityTarget,
  type ObjectLiteral,
} from "typeorm";
import { AIConfig } from "../entities/AIConfig.js";
import { AiRecommendation } from "../entities/AiRecommendation.js";
import { Answer } from "../entities/Answer.js";
import { Application } from "../entities/Application.js";
import { Conversation } from "../entities/Conversation.js";
import { Feedback } from "../entities/Feedback.js";
import { Job } from "../entities/Job.js";
import { Message } from "../entities/Message.js";
import { Notification } from "../entities/Notification.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationInvite } from "../entities/OrganizationInvite.js";
import { OrganizationJoinRequest } from "../entities/OrganizationJoinRequest.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { Payment } from "../entities/Payment.js";
import { PreScreening } from "../entities/PreScreening.js";
import { Question } from "../entities/Question.js";
import { Scout } from "../entities/Scout.js";
import { ScoutJob } from "../entities/ScoutJob.js";
import { Subscription } from "../entities/Subscription.js";
import { TalentEmbedding } from "../entities/TalentEmbedding.js";
import { User } from "../entities/User.js";
import {
  SEED_ORG_DOMAIN_LIKE,
  SEED_RECRUITER_EMAIL_LIKE,
  SEED_TALENT_EMAIL_LIKE,
} from "./config.js";

const IN_CHUNK = 400;

function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    chunks.push(ids.slice(i, i + IN_CHUNK));
  }
  return chunks;
}

async function deleteByIds(
  manager: EntityManager,
  entity: EntityTarget<ObjectLiteral>,
  ids: string[]
): Promise<void> {
  for (const slice of chunkIds(ids)) {
    if (slice.length === 0) continue;
    await manager.delete(entity, { id: In(slice) });
  }
}

export async function seedDataExists(ds: DataSource): Promise<boolean> {
  const userCount = await ds
    .getRepository(User)
    .createQueryBuilder("u")
    .where("u.email LIKE :talent OR u.email LIKE :recruiter", {
      talent: SEED_TALENT_EMAIL_LIKE,
      recruiter: SEED_RECRUITER_EMAIL_LIKE,
    })
    .getCount();
  if (userCount > 0) return true;

  const orgCount = await ds
    .getRepository(Organization)
    .createQueryBuilder("o")
    .where("o.domain LIKE :domain", { domain: SEED_ORG_DOMAIN_LIKE })
    .getCount();
  return orgCount > 0;
}

export async function resetSeedData(ds: DataSource): Promise<void> {
  await ds.transaction(async (manager) => {
    const seedUsers = await manager
      .createQueryBuilder(User, "u")
      .select(["u.id"])
      .where("u.email LIKE :talent OR u.email LIKE :recruiter", {
        talent: SEED_TALENT_EMAIL_LIKE,
        recruiter: SEED_RECRUITER_EMAIL_LIKE,
      })
      .getMany();
    const userIds = seedUsers.map((user) => user.id);

    const seedOrgs = await manager
      .createQueryBuilder(Organization, "o")
      .select(["o.id"])
      .where("o.domain LIKE :domain", { domain: SEED_ORG_DOMAIN_LIKE })
      .getMany();
    const orgIds = seedOrgs.map((org) => org.id);

    if (userIds.length === 0 && orgIds.length === 0) {
      return;
    }

    const jobs: Array<{ id: string }> = [];
    if (userIds.length > 0) {
      for (const slice of chunkIds(userIds)) {
        jobs.push(
          ...(await manager.find(Job, { where: { postedById: In(slice) }, select: { id: true } }))
        );
      }
    }
    if (orgIds.length > 0) {
      for (const slice of chunkIds(orgIds)) {
        jobs.push(
          ...(await manager.find(Job, {
            where: { organizationId: In(slice) },
            select: { id: true },
          }))
        );
      }
    }
    const jobIds = [...new Set(jobs.map((job) => job.id))];

    const applications: Array<{ id: string }> = [];
    if (userIds.length > 0) {
      for (const slice of chunkIds(userIds)) {
        applications.push(
          ...(await manager.find(Application, {
            where: { talentId: In(slice) },
            select: { id: true },
          })),
          ...(await manager.find(Application, {
            where: { recruiterId: In(slice) },
            select: { id: true },
          }))
        );
      }
    }
    if (jobIds.length > 0) {
      for (const slice of chunkIds(jobIds)) {
        applications.push(
          ...(await manager.find(Application, {
            where: { jobId: In(slice) },
            select: { id: true },
          }))
        );
      }
    }
    const applicationIds = [...new Set(applications.map((application) => application.id))];

    const conversationIds = new Set<string>();
    if (userIds.length > 0) {
      for (const slice of chunkIds(userIds)) {
        const rows: Array<{ conversation_id: string }> = await manager.query(
          `SELECT conversation_id FROM conversation_participants WHERE user_id = ANY($1::uuid[])`,
          [slice]
        );
        for (const row of rows) {
          conversationIds.add(row.conversation_id);
        }
      }
    }

    const messageIds = new Set<string>();
    if (applicationIds.length > 0) {
      for (const slice of chunkIds(applicationIds)) {
        const rows = await manager.find(Message, {
          where: { applicationId: In(slice) },
          select: { id: true },
        });
        for (const row of rows) messageIds.add(row.id);
      }
    }
    if (userIds.length > 0) {
      for (const slice of chunkIds(userIds)) {
        const sent = await manager.find(Message, {
          where: { senderId: In(slice) },
          select: { id: true },
        });
        const received = await manager.find(Message, {
          where: { recipientId: In(slice) },
          select: { id: true },
        });
        for (const row of [...sent, ...received]) messageIds.add(row.id);
      }
    }
    if (conversationIds.size > 0) {
      for (const slice of chunkIds([...conversationIds])) {
        const rows = await manager.find(Message, {
          where: { conversationId: In(slice) },
          select: { id: true },
        });
        for (const row of rows) messageIds.add(row.id);
      }
    }

    if (conversationIds.size > 0) {
      for (const slice of chunkIds([...conversationIds])) {
        await manager
          .createQueryBuilder()
          .update(Conversation)
          .set({ lastMessageId: null })
          .where("id IN (:...ids)", { ids: slice })
          .execute();
      }
    }

    await deleteByIds(manager, Message, [...messageIds]);

    if (userIds.length > 0) {
      for (const slice of chunkIds(userIds)) {
        await manager.query(
          `DELETE FROM conversation_participants WHERE user_id = ANY($1::uuid[])`,
          [slice]
        );
      }
    }
    await deleteByIds(manager, Conversation, [...conversationIds]);

    if (applicationIds.length > 0) {
      for (const slice of chunkIds(applicationIds)) {
        await manager.delete(AiRecommendation, { applicationId: In(slice) });
      }
    }

    if (userIds.length > 0) {
      for (const slice of chunkIds(userIds)) {
        await manager.delete(Answer, { userId: In(slice) });
        await manager.delete(Notification, { userId: In(slice) });
        await manager.delete(Feedback, { userId: In(slice) });
        await manager.delete(Payment, { userId: In(slice) });
        await manager.delete(Subscription, { userId: In(slice) });
        await manager.delete(TalentEmbedding, { userId: In(slice) });
      }
    }
    if (jobIds.length > 0) {
      for (const slice of chunkIds(jobIds)) {
        await manager.delete(Answer, { jobId: In(slice) });
        await manager.delete(Question, { jobId: In(slice) });
      }
    }

    await deleteByIds(manager, Application, applicationIds);

    const scoutJobs: Array<{ id: string }> = [];
    if (userIds.length > 0) {
      for (const slice of chunkIds(userIds)) {
        scoutJobs.push(
          ...(await manager.find(ScoutJob, {
            where: { postedById: In(slice) },
            select: { id: true },
          }))
        );
        await manager.delete(Scout, { recruiterId: In(slice) });
      }
    }
    if (orgIds.length > 0) {
      for (const slice of chunkIds(orgIds)) {
        scoutJobs.push(
          ...(await manager.find(ScoutJob, {
            where: { organizationId: In(slice) },
            select: { id: true },
          }))
        );
      }
    }
    const scoutJobIds = [...new Set(scoutJobs.map((row) => row.id))];
    if (scoutJobIds.length > 0) {
      for (const slice of chunkIds(scoutJobIds)) {
        await manager.delete(Scout, { scoutJobId: In(slice) });
      }
      await deleteByIds(manager, ScoutJob, scoutJobIds);
    }

    await deleteByIds(manager, Job, jobIds);

    if (userIds.length > 0) {
      for (const slice of chunkIds(userIds)) {
        await manager.delete(AIConfig, { recruiterId: In(slice) });
        await manager
          .createQueryBuilder()
          .update(User)
          .set({ activePreScreeningId: null, activeOrganizationId: null })
          .where("id IN (:...ids)", { ids: slice })
          .execute();
        await manager.delete(PreScreening, { userId: In(slice) });
        await manager.query(`DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])`, [slice]);
      }
    }

    if (orgIds.length > 0) {
      for (const slice of chunkIds(orgIds)) {
        await manager.delete(OrganizationMember, { organizationId: In(slice) });
        await manager.delete(OrganizationInvite, { organizationId: In(slice) });
        await manager.delete(OrganizationJoinRequest, { organizationId: In(slice) });
        await manager.update(AIConfig, { organizationId: In(slice) }, { organizationId: null });
        await manager
          .createQueryBuilder()
          .update(Organization)
          .set({ ownerId: null, verifiedById: null })
          .where("id IN (:...ids)", { ids: slice })
          .execute();
      }
      await deleteByIds(manager, Organization, orgIds);
    }

    await deleteByIds(manager, User, userIds);
  });
}
