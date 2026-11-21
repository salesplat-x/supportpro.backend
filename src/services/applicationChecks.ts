import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ApplicationCheck } from "../entities/ApplicationCheck.js";
import { ApplicationCheckEvent } from "../entities/ApplicationCheckEvent.js";
import { Job } from "../entities/Job.js";
import { Organization } from "../entities/Organization.js";
import { User } from "../entities/User.js";
import {
  AppError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errors";
import { decryptSecret } from "../utils/secretBox.js";
import type { CheckEventKind, CheckResult, CheckStatus, CheckType } from "../types/checks.js";
import { consentState, findConsent } from "./checkConsent.js";
import { overallStatus } from "./checkStatus.js";
import { isPostingCompanyMember } from "./jobPostingAccess.js";

const repo = () => AppDataSource.getRepository(ApplicationCheck);
const eventRepo = () => AppDataSource.getRepository(ApplicationCheckEvent);

const findApplication = async (applicationId: string): Promise<Application> => {
  const application = await AppDataSource.getRepository(Application).findOne({
    where: { id: applicationId },
    relations: { talent: true },
  });
  if (!application) throw new NotFoundError("Application not found");
  return application;
};

const findCheck = async (checkId: string): Promise<ApplicationCheck> => {
  const row = await repo().findOne({ where: { id: checkId } });
  if (!row) throw new NotFoundError("Check not found");
  return row;
};

const toCheck = (row: ApplicationCheck) => ({
  id: row.id,
  applicationId: row.applicationId,
  type: row.type,
  status: row.status,
  resultText: row.resultText,
  confirmedBy: row.confirmedBy,
  confirmedOn: row.confirmedOn,
  note: row.note,
  nameOnId: row.nameOnId,
  nameGiven: row.nameGiven,
  completedAt: row.completedAt,
  orderedById: row.orderedById,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const jobOwner = async (jobId: string): Promise<User | null> => {
  const job = await AppDataSource.getRepository(Job).findOne({
    where: { id: jobId },
    select: { id: true, organizationId: true, postedById: true },
  });
  if (!job) return null;
  let ownerId: string | null = job.postedById;
  if (job.organizationId) {
    const organization = await AppDataSource.getRepository(Organization).findOne({
      where: { id: job.organizationId },
      select: { id: true, ownerId: true },
    });
    ownerId = organization?.ownerId ?? null;
  }
  return ownerId ? AppDataSource.getRepository(User).findOne({ where: { id: ownerId } }) : null;
};

const fullName = (user: Pick<User, "firstName" | "lastName"> | null): string =>
  user ? `${user.firstName} ${user.lastName}`.trim() : "";

const countryOf = (talent: User): string =>
  (talent.country ?? talent.locationCountry ?? "").trim().toLowerCase();

const criminalAvailable = (talent: User): boolean =>
  env.criminalCheckCountries.includes(countryOf(talent));

const recordEvents = async (
  events: Array<{
    applicationId: string;
    checkId: string;
    actorId: string;
    kind: CheckEventKind;
    detail?: string | null;
  }>
): Promise<void> => {
  if (!events.length) return;
  await eventRepo().insert(events.map((event) => ({ ...event, detail: event.detail ?? null })));
};

export const orderCheck = async (userId: string, applicationId: string, type: CheckType) => {
  const application = await findApplication(applicationId);
  if (!(await isPostingCompanyMember(userId, application.jobId))) {
    throw new AuthorizationError("Only the company that posted this job can order checks");
  }
  const consent = await findConsent(applicationId);
  if (!consent?.agreedAt) {
    throw new ConflictError(
      consent?.declinedAt
        ? "The candidate declined background checks"
        : "The candidate has not agreed to background checks yet"
    );
  }
  if (type === "criminal" && !criminalAvailable(application.talent)) {
    throw new AppError(
      409,
      "NOT_AVAILABLE_IN_COUNTRY",
      "Criminal checks are not available in this country"
    );
  }
  if (await repo().exists({ where: { applicationId, type } })) {
    throw new ConflictError(`A ${type} check was already ordered for this application`);
  }
  const saved = await AppDataSource.transaction(async (manager) => {
    const check = await manager.getRepository(ApplicationCheck).save(
      manager.getRepository(ApplicationCheck).create({
        applicationId,
        orderedById: userId,
        type,
        status: "pending",
        resultText: null,
      })
    );
    await manager
      .getRepository(ApplicationCheckEvent)
      .insert({ applicationId, checkId: check.id, actorId: userId, kind: "ordered", detail: null });
    return check;
  });
  return toCheck(saved);
};

const mayReadResult = async (
  userId: string,
  row: ApplicationCheck,
  jobId: string
): Promise<boolean> => {
  if (row.orderedById === userId) return true;
  const owner = await jobOwner(jobId);
  return owner?.id === userId;
};

export const listChecksForCompany = async (userId: string, applicationId: string) => {
  const application = await findApplication(applicationId);
  const owner = await jobOwner(application.jobId);
  const isOwner = owner?.id === userId;
  if (!isOwner && !(await isPostingCompanyMember(userId, application.jobId))) {
    throw new AuthorizationError("Only the company that posted this job can read its checks");
  }
  const rows = await repo().find({ where: { applicationId }, order: { createdAt: "ASC" } });
  const visible = rows.filter((row) => isOwner || row.orderedById === userId);
  const viewed = visible.filter((row) => row.completedAt);
  await recordEvents(
    viewed.map((row) => ({
      applicationId,
      checkId: row.id,
      actorId: userId,
      kind: "viewed" as const,
      detail: row.status,
    }))
  );
  const consent = await findConsent(applicationId);
  return {
    applicationId,
    candidateName: fullName(application.talent),
    consent: consentState(consent),
    overallStatus: overallStatus(rows),
    criminalAvailable: criminalAvailable(application.talent),
    ownerName: fullName(owner),
    checks: rows.map((row) =>
      isOwner || row.orderedById === userId
        ? { ...toCheck(row), restricted: false as const }
        : { id: row.id, applicationId, type: row.type, restricted: true as const }
    ),
  };
};

const normalizedName = (name: string): string =>
  name.toLowerCase().split(/\s+/).filter(Boolean).sort().join(" ");

export interface CheckResultInput {
  confirmedBy?: string;
  confirmedOn: string;
  result?: CheckResult;
  nameOnId?: string;
  note?: string;
}

export const saveCheckResult = async (userId: string, checkId: string, input: CheckResultInput) => {
  const row = await findCheck(checkId);
  const application = await findApplication(row.applicationId);
  if (!(await mayReadResult(userId, row, application.jobId))) {
    throw new AuthorizationError(
      "Only the person who ordered this check and the company owner can enter its result"
    );
  }

  if (
    row.type === "identity" ? !input.nameOnId?.trim() : !input.confirmedBy?.trim() || !input.result
  ) {
    throw new ValidationError(
      row.type === "identity"
        ? "nameOnId is required for an identity check"
        : "confirmedBy and result are required for this check"
    );
  }

  row.confirmedOn = input.confirmedOn;
  row.note = input.note?.trim() || null;
  row.completedAt = new Date();
  if (row.type === "identity") {
    const nameGiven = fullName(application.talent);
    const matches = normalizedName(input.nameOnId!) === normalizedName(nameGiven);
    row.nameOnId = input.nameOnId!.trim();
    row.nameGiven = nameGiven;
    row.confirmedBy = null;
    row.status = matches ? "passed" : "failed";
    row.resultText = matches ? "The names match" : "The names do not match";
  } else {
    const statusByResult: Record<CheckResult, CheckStatus> = {
      verified: "passed",
      flagged: "flagged",
      failed: "failed",
    };
    row.confirmedBy = input.confirmedBy!.trim();
    row.status = statusByResult[input.result!];
    row.resultText = row.note;
  }

  const saved = await AppDataSource.transaction(async (manager) => {
    const check = await manager.getRepository(ApplicationCheck).save(row);
    await manager.getRepository(ApplicationCheckEvent).insert({
      applicationId: check.applicationId,
      checkId: check.id,
      actorId: userId,
      kind: "result_saved",
      detail: check.status,
    });
    return check;
  });
  return toCheck(saved);
};

export const listCheckHistory = async (userId: string, checkId: string) => {
  const row = await findCheck(checkId);
  const application = await findApplication(row.applicationId);
  if (!(await mayReadResult(userId, row, application.jobId))) {
    throw new AuthorizationError(
      "Only the person who ordered this check and the company owner can read its history"
    );
  }
  const events = await eventRepo().find({
    where: { checkId },
    relations: { actor: true },
    order: { createdAt: "ASC" },
  });
  return {
    checkId,
    type: row.type,
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind,
      detail: event.detail,
      actorName: fullName(event.actor) || null,
      createdAt: event.createdAt,
    })),
  };
};

export const readIdNumber = async (userId: string, checkId: string) => {
  const row = await findCheck(checkId);
  if (row.type !== "identity") throw new NotFoundError("Check not found");
  const application = await findApplication(row.applicationId);
  if (!(await mayReadResult(userId, row, application.jobId))) {
    throw new AuthorizationError(
      "Only the person who ordered this check and the company owner can read the ID number"
    );
  }
  const consent = await findConsent(row.applicationId);
  if (!consent?.agreedAt || !consent.idNumberEncrypted || !consent.idKind) {
    throw new ConflictError("The candidate has not given an ID number");
  }
  await recordEvents([
    {
      applicationId: row.applicationId,
      checkId: row.id,
      actorId: userId,
      kind: "id_number_viewed",
    },
  ]);
  return { checkId, idKind: consent.idKind, idNumber: decryptSecret(consent.idNumberEncrypted) };
};
