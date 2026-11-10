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

export type ReferenceStatus = "not_sent" | "sent" | "answered" | "expired";

export interface RefereeInput {
  name: string;
  email: string;
  relationship: string;
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

export const addReferee = async (userId: string, applicationId: string, input: RefereeInput) => {
  const application = await ownApplication(userId, applicationId);
  const email = input.email.trim().toLowerCase();
  const existing = await repo().find({ where: { applicationId } });
  if (existing.length >= MAX_REFEREES) {
    throw new ValidationError(`You can name at most ${MAX_REFEREES} referees`);
  }
  if (existing.some((row) => row.email === email)) {
    throw new ConflictError("This referee has already been added");
  }
  const { token, tokenHash, expiresAt } = newToken();
  const saved = await repo().save(
    repo().create({
      applicationId,
      jobId: application.jobId,
      talentId: application.talentId,
      name: input.name.trim(),
      email,
      relationship: input.relationship.trim(),
      tokenHash,
      tokenExpiresAt: expiresAt,
    })
  );
  await sendReferenceEmail(saved, token);
  return toReferee(await repo().findOneByOrFail({ id: saved.id }));
};

export const listRefereesForCandidate = async (userId: string, applicationId: string) => {
  await ownApplication(userId, applicationId);
  const rows = await repo().find({ where: { applicationId }, order: { createdAt: "ASC" } });
  return { applicationId, references: rows.map(toReferee) };
};
