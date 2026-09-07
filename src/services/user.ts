import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Application, Role, TalentEmbedding, User } from "../entities";
import { NotFoundError, ValidationError, AuthorizationError } from "../utils/errors";
import logger from "../utils/logger.js";
import { UserRole, ApplicationStatus, ApplicationType, CvEmbeddingStatus } from "../types/enums.js";
import { generateCvPdf } from "../utils/cvPdf.js";
import { extractText, overlapChunkText, preprocessText, sortDirection } from "../utils/text.js";
import { createEmbedding } from "../utils/integrations/openai.js";
import {
  MAX_DURABLE_ATTEMPTS,
  STALE_LOCK_INTERVAL,
  SWEEP_BATCH_SIZE,
  claimRowById,
  durableFailureUpdate,
  selectDueIds,
} from "../utils/durableJobs.js";

// mammoth (used by extractText) only supports .docx, not legacy binary .doc —
// keep this in sync with what extractText can actually parse.
const ALLOWED_CV_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

/** Talent has an uploaded CV when extraction was persisted. */
export const hasUploadedCv = (
  user: Pick<User, "cvUploadedAt" | "cvFileName" | "cvText">
): boolean => !!(user.cvUploadedAt || user.cvFileName || user.cvText);

const ROLE_CHANGE_LIMIT = 3;

const userRepo = () => AppDataSource.getRepository(User);
const roleRepo = () => AppDataSource.getRepository(Role);
const applicationRepo = () => AppDataSource.getRepository(Application);

// ---- Profile completion helpers ----

export const getProfileCompletion = (
  user: User
): {
  percentage: number;
  isProfileComplete: boolean;
  canProceedToPlatform: boolean;
} => {
  const fields = [
    !!user.bio,
    hasUploadedCv(user),
    !!user.workType?.length,
    !!user.locationCountry,
    !!user.experience,
    !!(user.maxSalary && user.minSalary),
    !!user.userRoles?.length,
  ];
  const completed = fields.filter(Boolean).length;
  const percentage = Math.round((completed / fields.length) * 100);
  const isProfileComplete = percentage === 100;
  const canProceedToPlatform = !!(hasUploadedCv(user) && user.userRoles?.length);
  return { percentage, isProfileComplete, canProceedToPlatform };
};

const validateAndFetchRoles = async (roleIds: string[]): Promise<Role[]> => {
  if (roleIds.length === 0) return [];
  const roles = await roleRepo().findBy({ id: In(roleIds) });
  const missing = roleIds.find((id) => !roles.find((r) => r.id === id));
  if (missing) throw new NotFoundError(`Role does not exist: ${missing}`);
  return roles;
};

const rolesChanged = (existingRoles: Role[], incomingIds: string[]): boolean => {
  const existing = existingRoles.map((r) => r.id).sort();
  const incoming = [...incomingIds].sort();
  return JSON.stringify(existing) !== JSON.stringify(incoming);
};

export interface UpdateUserPayload {
  firstName?: string;
  lastName?: string;
  country?: string;
  bio?: string;
  roleIds?: string[];
  locationCity?: string;
  locationState?: string;
  locationCountry?: string;
  experience?: string;
  minSalary?: number;
  maxSalary?: number;
  currency?: string;
  compensationPeriod?: string;
  workType?: string[];
}

export const updateUser = async (userId: string, payload: UpdateUserPayload): Promise<User> => {
  const existingUser = await userRepo().findOne({
    where: { id: userId },
    relations: { userRoles: true },
  });
  if (!existingUser) {
    throw new NotFoundError("Authenticated user no longer exists");
  }

  const update: Partial<User> = {};

  // Basic user fields
  if (payload.firstName !== undefined) update.firstName = payload.firstName;
  if (payload.lastName !== undefined) update.lastName = payload.lastName;
  if (payload.country !== undefined) update.country = payload.country;

  // Profile fields
  if (payload.bio !== undefined) update.bio = payload.bio;
  if (payload.locationCity !== undefined) update.locationCity = payload.locationCity;
  if (payload.locationState !== undefined) update.locationState = payload.locationState;
  if (payload.locationCountry !== undefined) update.locationCountry = payload.locationCountry;
  if (payload.experience !== undefined) update.experience = payload.experience;
  if (payload.minSalary !== undefined) update.minSalary = payload.minSalary;
  if (payload.maxSalary !== undefined) update.maxSalary = payload.maxSalary;
  if (payload.currency !== undefined) update.currency = payload.currency as User["currency"];
  if (payload.compensationPeriod !== undefined)
    update.compensationPeriod = payload.compensationPeriod as User["compensationPeriod"];
  if (payload.workType !== undefined) update.workType = payload.workType;

  // Role changes
  if (payload.roleIds !== undefined) {
    const newRoles = await validateAndFetchRoles(payload.roleIds);
    if (rolesChanged(existingUser.userRoles ?? [], payload.roleIds)) {
      const currentCount = existingUser.roleChangeCount ?? 0;
      if (currentCount >= ROLE_CHANGE_LIMIT) {
        throw new ValidationError(
          "Role change limit reached. You may only change your role 3 times."
        );
      }
      update.roleChangeCount = currentCount + 1;
    }
    existingUser.userRoles = newRoles;
  }

  const saved = await userRepo().save({ ...existingUser, ...update });
  return saved;
};

export interface EditProfilePayload {
  bio?: string;
  roleIds?: string[];
  locationCity?: string;
  locationState?: string;
  locationCountry?: string;
  experience?: string;
  minSalary?: number;
  maxSalary?: number;
  currency?: string;
  compensationPeriod?: string;
  workType?: string[];
}

export const editProfile = async (
  userId: string,
  payload: EditProfilePayload,
  file?: Express.Multer.File
): Promise<User> => {
  const existingUser = await userRepo().findOne({
    where: { id: userId },
    relations: { userRoles: true },
  });
  if (!existingUser) {
    throw new NotFoundError("Authenticated user no longer exists");
  }

  const update: Partial<User> = {};

  if (payload.bio !== undefined) update.bio = payload.bio;
  if (payload.locationCity !== undefined) update.locationCity = payload.locationCity;
  if (payload.locationState !== undefined) update.locationState = payload.locationState;
  if (payload.locationCountry !== undefined) update.locationCountry = payload.locationCountry;
  if (payload.experience !== undefined) update.experience = payload.experience;
  if (payload.minSalary !== undefined) update.minSalary = payload.minSalary;
  if (payload.maxSalary !== undefined) update.maxSalary = payload.maxSalary;
  if (payload.currency !== undefined) update.currency = payload.currency as User["currency"];
  if (payload.compensationPeriod !== undefined)
    update.compensationPeriod = payload.compensationPeriod as User["compensationPeriod"];
  if (payload.workType !== undefined) update.workType = payload.workType;

  let roleDidChange = false;
  let embeddingPromise: Promise<void> | undefined;

  if (payload.roleIds !== undefined) {
    const newRoles = await validateAndFetchRoles(payload.roleIds);
    if (rolesChanged(existingUser.userRoles ?? [], payload.roleIds)) {
      const currentCount = existingUser.roleChangeCount ?? 0;
      if (currentCount >= ROLE_CHANGE_LIMIT) {
        throw new ValidationError(
          "Role change limit reached. You may only change your role 3 times."
        );
      }
      update.roleChangeCount = currentCount + 1;
      roleDidChange = true;
    }
    existingUser.userRoles = newRoles;
  }

  if (file) {
    if (!ALLOWED_CV_TYPES.includes(file.mimetype)) {
      throw new ValidationError("Unsupported CV file type");
    }

    let text: string;
    try {
      text = await extractText(file.buffer, file.mimetype);
      if (!text?.trim()) {
        throw new ValidationError("Unable to extract text from CV");
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`CV processing failed for user ${userId}: ${message}`);
      throw new ValidationError(
        "We couldn't process this CV file. Please upload a PDF or DOCX file."
      );
    }

    // Persist extracted content + original file name; file binary is discarded.
    update.cvText = text.trim();
    update.cvFileName = file.originalname || "cv.pdf";
    update.cvUploadedAt = new Date();
    update.cvEmbeddingStatus = CvEmbeddingStatus.Pending;
    update.cvEmbeddingAttempts = 0;
    update.cvEmbeddingNextRetryAt = null;
    update.cvEmbeddingLockedAt = null;
    update.cvEmbeddingLastError = null;
  }

  const saved = await userRepo().save({ ...existingUser, ...update });

  if (file) {
    // Generate embedding asynchronously after the CV row is committed — not needed
    // for the response, takes 5–20s. The returned promise always resolves so
    // callers can await "embedding write settled" without their own try/catch.
    embeddingPromise = new Promise<void>((resolve) => {
      setImmediate(() => {
        generateCvEmbeddingForUser(userId)
          .catch((err: Error) =>
            logger.error(`CV embedding generation failed for user ${userId}: ${err.message}`)
          )
          .finally(resolve);
      });
    });
  }

  // Only a role change regenerates the assessment — CV replacement (or any other
  // profile edit) must never trigger a new assessment. Initial generation for a
  // profile that has just become complete is handled lazily by getActivePreScreening().
  if (roleDidChange) {
    const triggerGeneration = () => {
      // Fire-and-forget: prescreening generation is non-blocking but errors must be logged.
      // The dynamic import avoids a circular dependency (prescreening.ts imports user.ts).
      import("./prescreening.js")
        .then(({ triggerPreScreeningGeneration }) => triggerPreScreeningGeneration(saved))
        .catch((err: unknown) => {
          logger.error("Prescreening generation failed after profile update", {
            userId: saved.id,
            message: err instanceof Error ? err.message : String(err),
          });
        });
    };

    // If this request also replaced the CV, wait for its embedding write to settle
    // first — otherwise generation can read stale or half-written TalentEmbedding rows.
    if (embeddingPromise) {
      void embeddingPromise.then(triggerGeneration);
    } else {
      triggerGeneration();
    }
  }

  return saved;
};

export const saveTalentEmbedding = async (
  userId: string,
  cvText: string[],
  cvEmbedding: Array<{ embedding: number[] }>
): Promise<void> => {
  const repo = AppDataSource.getRepository(TalentEmbedding);
  await repo.delete({ userId });
  for (let j = 0; j < cvEmbedding.length; j++) {
    const embeddingStr = `[${cvEmbedding[j]!.embedding.toString()}]`;
    await repo.save(
      repo.create({
        userId,
        cvText: cvText[j] ?? null,
        cvEmbedding: embeddingStr,
        generatedAt: new Date(),
      })
    );
  }
};

const CLAIM_CV_EMBEDDING_SQL = `
  UPDATE "users"
  SET "cvEmbeddingLockedAt" = NOW(),
      "cvEmbeddingStatus" = 'pending'
  WHERE "id" = $1
    AND "cvEmbeddingStatus" IN ('pending', 'failed')
    AND "cvEmbeddingAttempts" < ${MAX_DURABLE_ATTEMPTS}
    AND ("cvEmbeddingNextRetryAt" IS NULL OR "cvEmbeddingNextRetryAt" <= NOW())
    AND ("cvEmbeddingLockedAt" IS NULL OR "cvEmbeddingLockedAt" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  RETURNING "id"
`;

const DUE_CV_EMBEDDING_SQL = `
  SELECT "id" FROM "users"
  WHERE "cvText" IS NOT NULL
    AND "cvUploadedAt" IS NOT NULL
    AND "cvEmbeddingStatus" IN ('pending', 'failed')
    AND "cvEmbeddingAttempts" < $1
    AND ("cvEmbeddingNextRetryAt" IS NULL OR "cvEmbeddingNextRetryAt" <= NOW())
    AND ("cvEmbeddingLockedAt" IS NULL OR "cvEmbeddingLockedAt" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  LIMIT $2
`;

const recordCvEmbeddingFailure = async (
  userId: string,
  err: unknown,
  options: { permanent?: boolean } = {}
): Promise<void> => {
  const row = await userRepo().findOne({
    where: { id: userId },
    select: { id: true, cvEmbeddingAttempts: true },
  });
  const currentAttempts = row?.cvEmbeddingAttempts ?? 0;
  const patch = options.permanent
    ? {
        attempts: MAX_DURABLE_ATTEMPTS,
        nextRetryAt: null as Date | null,
        lockedAt: null,
        lastError: err instanceof Error ? err.message : String(err),
        exhausted: true,
      }
    : durableFailureUpdate(currentAttempts, err);

  await userRepo().update(userId, {
    cvEmbeddingStatus: patch.exhausted ? CvEmbeddingStatus.Failed : CvEmbeddingStatus.Pending,
    cvEmbeddingAttempts: patch.attempts,
    cvEmbeddingNextRetryAt: patch.nextRetryAt,
    cvEmbeddingLockedAt: patch.lockedAt,
    cvEmbeddingLastError: patch.lastError,
  });
};

export const generateCvEmbeddingForUser = async (userId: string): Promise<void> => {
  const claimed = await claimRowById(CLAIM_CV_EMBEDDING_SQL, userId);
  if (!claimed) return;

  try {
    const user = await userRepo()
      .createQueryBuilder("user")
      .addSelect("user.cvText")
      .where("user.id = :userId", { userId })
      .getOne();
    const text = user?.cvText?.trim();
    if (!text) {
      await recordCvEmbeddingFailure(userId, new Error("No CV text is stored"), {
        permanent: true,
      });
      return;
    }

    const chunks = overlapChunkText(preprocessText(text));
    const embeddings = await createEmbedding(chunks);
    await saveTalentEmbedding(userId, chunks, embeddings);
    await userRepo().update(userId, {
      cvEmbeddingStatus: CvEmbeddingStatus.Ready,
      cvEmbeddingLockedAt: null,
      cvEmbeddingNextRetryAt: null,
      cvEmbeddingLastError: null,
    });
  } catch (err) {
    logger.error(
      `CV embedding generation failed for user ${userId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    await recordCvEmbeddingFailure(userId, err);
    throw err;
  }
};

export const reconcileDueCvEmbeddings = async (): Promise<{
  scanned: number;
  healed: number;
  failed: number;
}> => {
  const ids = await selectDueIds(DUE_CV_EMBEDDING_SQL, [MAX_DURABLE_ATTEMPTS, SWEEP_BATCH_SIZE]);
  let healed = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await generateCvEmbeddingForUser(id);
      const user = await userRepo().findOne({
        where: { id },
        select: { id: true, cvEmbeddingStatus: true },
      });
      if (user?.cvEmbeddingStatus === CvEmbeddingStatus.Ready) healed++;
      else failed++;
    } catch {
      failed++;
    }
  }
  if (ids.length > 0) {
    logger.info(
      `CV embedding reconciliation sweep: scanned ${ids.length}, healed ${healed}, failed ${failed}`
    );
  }
  return { scanned: ids.length, healed, failed };
};

export const me = async (userId: string): Promise<User> => {
  const user = await userRepo().findOne({
    where: { id: userId },
    relations: { userRoles: true, activeOrganization: true },
  });
  if (!user) {
    throw new NotFoundError("Authenticated user no longer exists");
  }
  return user;
};

export const viewProfile = async (
  targetUserId: string
): Promise<User & { hasEmbedding: boolean }> => {
  const user = await userRepo().findOne({
    where: { id: targetUserId },
    relations: { userRoles: true },
  });
  if (!user) {
    throw new NotFoundError("User not found");
  }
  if (user.userRole !== UserRole.Talent) {
    throw new NotFoundError("User not a talent");
  }
  const hasEmbedding = await AppDataSource.getRepository(TalentEmbedding).exists({
    where: { userId: targetUserId },
  });
  return { ...user, hasEmbedding };
};

/** Recruiter-triggered manual CV re-embed — only allowed for a talent the recruiter has an application with. */
export const reprocessCv = async (recruiterId: string, talentId: string): Promise<void> => {
  const owns = await applicationRepo().exists({ where: { talentId, recruiterId } });
  if (!owns) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  const user = await userRepo()
    .createQueryBuilder("user")
    .addSelect("user.cvText")
    .where("user.id = :talentId", { talentId })
    .getOne();

  if (!user || user.userRole !== UserRole.Talent) {
    throw new NotFoundError("Talent not found");
  }
  if (!user.cvText?.trim()) {
    throw new ValidationError("No CV text is stored for this talent");
  }

  await userRepo().update(talentId, {
    cvEmbeddingStatus: CvEmbeddingStatus.Pending,
    cvEmbeddingAttempts: 0,
    cvEmbeddingNextRetryAt: null,
    cvEmbeddingLockedAt: null,
    cvEmbeddingLastError: null,
  });

  await generateCvEmbeddingForUser(talentId);
};

export const getTalentCvPdf = async (
  talentId: string
): Promise<{ buffer: Buffer; fileName: string }> => {
  const user = await userRepo()
    .createQueryBuilder("user")
    .addSelect("user.cvText")
    .where("user.id = :talentId", { talentId })
    .getOne();

  if (!user || user.userRole !== UserRole.Talent) {
    throw new NotFoundError("Talent not found");
  }
  if (!user.cvText?.trim()) {
    throw new NotFoundError("CV not available for this talent");
  }

  const location = [user.locationCity, user.locationState, user.locationCountry]
    .filter(Boolean)
    .join(", ");

  const buffer = await generateCvPdf({
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    location: location || null,
    fileName: user.cvFileName,
    cvText: user.cvText,
  });

  const baseName = (user.cvFileName || `${user.firstName}-${user.lastName}-cv`)
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.-]+/g, "-");

  return { buffer, fileName: `${baseName || "cv"}.pdf` };
};

export interface FetchProfilesParams {
  roleId?: string;
  experience?: string;
  minScore?: string | number;
  maxSalary?: string | number;
  incomplete?: boolean | string;
  limit?: number | string;
  offset?: number | string;
  sort?: string;
}

export const viewProfilesForRole = async (payload: FetchProfilesParams): Promise<User[]> => {
  const qb = userRepo()
    .createQueryBuilder("user")
    .leftJoinAndSelect("user.userRoles", "userRoles")
    .where("user.userRole = :role", { role: UserRole.Talent });

  if (payload.roleId) {
    const role = await roleRepo().findOne({ where: { id: payload.roleId } });
    if (!role) {
      throw new NotFoundError("Role does not exist");
    }
    qb.andWhere("userRoles.id = :roleId", { roleId: payload.roleId });
  }

  if (payload.experience) {
    qb.andWhere("user.experience = :experience", { experience: payload.experience });
  }

  if (payload.minScore) {
    qb.andWhere("user.prescreeningScore >= :minScore", { minScore: Number(payload.minScore) });
  }

  if (payload.maxSalary) {
    qb.andWhere("user.maxSalary <= :maxSalary", { maxSalary: Number(payload.maxSalary) });
  }

  if (!payload.incomplete) {
    qb.andWhere("user.prescreeningScore IS NOT NULL");
  }

  const limit = Number(payload.limit) || 50;
  const offset = Number(payload.offset) || 0;

  qb.orderBy("user.prescreeningScore", "DESC").skip(offset).take(limit);

  return qb.getMany();
};

export interface FetchApplicationsParams {
  applicationType?: ApplicationType;
  applicationStatus?: ApplicationStatus;
  limit?: number | string;
  offset?: number | string;
  sort?: string;
}

export const userApplications = async (
  userId: string,
  payload: FetchApplicationsParams
): Promise<Application[]> => {
  const qb = applicationRepo()
    .createQueryBuilder("application")
    .leftJoinAndSelect("application.job", "job")
    .leftJoinAndSelect("job.postedBy", "postedBy")
    .leftJoinAndSelect("job.role", "role")
    .leftJoinAndSelect("job.organization", "organization")
    .where("application.talent_id = :userId", { userId });

  if (payload.applicationType) {
    qb.andWhere("application.applicationType = :applicationType", {
      applicationType: payload.applicationType,
    });
  }

  if (payload.applicationStatus) {
    qb.andWhere("application.status = :status", { status: payload.applicationStatus });
  }

  const limit = Number(payload.limit) || 50;
  const offset = Number(payload.offset) || 0;
  const order = sortDirection(payload.sort ?? "desc");

  return qb.orderBy("application.createdAt", order).skip(offset).take(limit).getMany();
};
