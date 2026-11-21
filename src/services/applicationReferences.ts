import { createHash, randomBytes } from "crypto";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ApplicationReference } from "../entities/ApplicationReference.js";
import EmailService from "../utils/integrations/email/emailService.js";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import logger from "../utils/logger.js";

export const MAX_REFEREES = 3;
export const REFERENCE_LINK_DAYS = 14;

export const REFEREE_RELATIONSHIPS = ["manager", "colleague", "client", "other"] as const;
export type RefereeRelationship = (typeof REFEREE_RELATIONSHIPS)[number];

export type ReferenceStatus = "not_sent" | "sent" | "answered" | "expired";

export interface RefereeInput {
  name: string;
  email: string;
  relationship: RefereeRelationship;
}

const repo = () => AppDataSource.getRepository(ApplicationReference);

export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export const newToken = (): { token: string; tokenHash: string; expiresAt: Date } => {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + REFERENCE_LINK_DAYS * 24 * 60 * 60 * 1000);
  return { token, tokenHash: hashToken(token), expiresAt };
};

export const referenceStatus = (row: ApplicationReference): ReferenceStatus => {
  if (row.answeredAt) return "answered";
  if (row.tokenExpiresAt.getTime() <= Date.now()) return "expired";
  return row.sentAt ? "sent" : "not_sent";
};

export const toReferee = (row: ApplicationReference) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  relationship: row.relationship,
  status: referenceStatus(row),
  sentAt: row.sentAt,
  expiresAt: row.tokenExpiresAt,
  answeredAt: row.answeredAt,
});

export const sendReferenceEmail = async (
  row: ApplicationReference,
  token: string
): Promise<boolean> => {
  const application = await AppDataSource.getRepository(Application).findOne({
    where: { id: row.applicationId },
    relations: { job: { role: true, organization: true }, talent: true },
  });
  if (!application) return false;
  try {
    await new EmailService().sendReferenceRequest({
      to: row.email,
      refereeName: row.name,
      candidateName: `${application.talent.firstName} ${application.talent.lastName}`.trim(),
      jobTitle: application.job.role?.name ?? "a job",
      companyName: application.job.organization?.name,
      ctaUrl: `${env.website || "https://auxhr.com"}/reference/${token}`,
    });
    await repo().update(row.id, { sentAt: new Date() });
    return true;
  } catch (error) {
    logger.warn(`Reference email for ${row.id} failed: ${String(error)}`);
    return false;
  }
};

const ownApplication = async (userId: string, applicationId: string): Promise<Application> => {
  const application = await AppDataSource.getRepository(Application).findOne({
    where: { id: applicationId },
  });
  if (!application) throw new NotFoundError("Application not found");
  if (application.talentId !== userId) {
    throw new AuthorizationError("Only the candidate can manage their referees");
  }
  return application;
};

export const addReferees = async (
  userId: string,
  applicationId: string,
  inputs: RefereeInput[]
) => {
  const application = await ownApplication(userId, applicationId);
  const existing = await repo().find({ where: { applicationId } });
  if (existing.length + inputs.length > MAX_REFEREES) {
    throw new ValidationError(`You can name at most ${MAX_REFEREES} referees`);
  }
  const taken = new Set(existing.map((row) => row.email));
  const prepared = inputs.map((input) => ({ ...input, email: input.email.trim().toLowerCase() }));
  for (const { email } of prepared) {
    if (taken.has(email)) throw new ConflictError("This referee has already been added");
    taken.add(email);
  }
  const issued = prepared.map((input) => ({ input, ...newToken() }));
  const saved = await repo().save(
    issued.map(({ input, tokenHash, expiresAt }) =>
      repo().create({
        applicationId,
        jobId: application.jobId,
        talentId: application.talentId,
        name: input.name.trim(),
        email: input.email,
        relationship: input.relationship,
        tokenHash,
        tokenExpiresAt: expiresAt,
      })
    )
  );
  await Promise.all(saved.map((row, index) => sendReferenceEmail(row, issued[index]!.token)));
  const rows = await repo().find({ where: { applicationId }, order: { createdAt: "ASC" } });
  return { applicationId, references: rows.map(toReferee) };
};

export const listRefereesForCandidate = async (userId: string, applicationId: string) => {
  await ownApplication(userId, applicationId);
  const rows = await repo().find({ where: { applicationId }, order: { createdAt: "ASC" } });
  return { applicationId, references: rows.map(toReferee) };
};
