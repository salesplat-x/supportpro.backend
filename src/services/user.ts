import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Application, Role, TalentEmbedding, User } from "../entities";
import { NotFoundError, ValidationError } from "../utils/errors";
import logger from "../utils/logger.js";
import { UserRole, ApplicationStatus, ApplicationType } from "../types/enums.js";
import { replaceAsset, extractPublicIdFromUrl } from "../utils/integrations/cloudinary.js";
import { extractText, overlapChunkText, preprocessText, sortDirection } from "../utils/text.js";
import { createEmbedding } from "../utils/integrations/openai.js";

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// mammoth (used by extractText) only supports .docx, not legacy binary .doc —
// keep this in sync with what extractText can actually parse.
const ALLOWED_CV_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const CV_EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

const CLOUDINARY_FOLDERS = {
  images: "salesplate/images",
  cv: "salesplate/cv",
} as const;

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
    !!user.cvUrl,
    !!user.workType?.length,
    !!user.locationCountry,
    !!user.experience,
    !!(user.maxSalary && user.minSalary),
    !!user.userRoles?.length,
  ];
  const completed = fields.filter(Boolean).length;
  const percentage = Math.round((completed / fields.length) * 100);
  const isProfileComplete = percentage === 100;
  const canProceedToPlatform = !!(user.cvUrl && user.userRoles?.length);
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
  phone?: string;
  country?: string;
  picture?: string;
  cv?: string;
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
  if (payload.phone !== undefined) update.phone = payload.phone;
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

  // Profile image
  if (payload.picture) {
    const newPublicId = extractPublicIdFromUrl(payload.picture);
    update.profileImageUrl = payload.picture;
    update.profileImagePublicId = newPublicId ?? null;
  }

  // CV URL update (without file — e.g. when cv is passed as a URL)
  if (payload.cv) {
    const newCvPublicId = extractPublicIdFromUrl(payload.cv);
    update.cvUrl = payload.cv;
    update.cvPublicId = newCvPublicId ?? null;
    update.cvUploadedAt = new Date();
  }

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
    let asset: Awaited<ReturnType<typeof replaceAsset>>;
    try {
      text = await extractText(file.buffer, file.mimetype);
      if (!text) {
        throw new ValidationError("Unable to extract text from CV");
      }

      asset = await replaceAsset(existingUser.cvPublicId ?? undefined, file.buffer, {
        folder: CLOUDINARY_FOLDERS.cv,
        publicId: `${userId}-cv`,
        mimetype: file.mimetype,
        format: CV_EXT_BY_MIME[file.mimetype],
        // CVs are non-image documents — Cloudinary stores them as "raw", and
        // its destroy API (unlike upload) rejects "auto".
        resourceType: "raw",
      });
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`CV processing failed for user ${userId}: ${message}`);
      throw new ValidationError(
        "We couldn't process this CV file. Please upload a PDF or DOCX file."
      );
    }

    const processedText = overlapChunkText(preprocessText(text));

    update.cvUrl = asset.url;
    update.cvPublicId = asset.publicId;
    update.cvUploadedAt = new Date();

    // Generate embedding asynchronously — not needed for the response, takes 5–20s.
    // The returned promise always resolves (never rejects) so callers can await
    // "embedding write settled" without needing their own try/catch.
    const textSnapshot = [...processedText];
    embeddingPromise = new Promise<void>((resolve) => {
      setImmediate(() => {
        createEmbedding(textSnapshot)
          .then((cvEmbedding) => saveTalentEmbedding(userId, textSnapshot, cvEmbedding))
          .catch((err: Error) =>
            logger.error(`CV embedding generation failed for user ${userId}: ${err.message}`)
          )
          .finally(resolve);
      });
    });
  }

  const saved = await userRepo().save({ ...existingUser, ...update });

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

export const me = async (userId: string): Promise<User> => {
  const user = await userRepo().findOne({
    where: { id: userId },
    relations: { userRoles: true, organization: true },
  });
  if (!user) {
    throw new NotFoundError("Authenticated user no longer exists");
  }
  return user;
};

export const viewProfile = async (targetUserId: string): Promise<User> => {
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
  return user;
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

export const uploadProfileImage = async (
  userId: string,
  file?: Express.Multer.File
): Promise<User> => {
  if (!file) {
    throw new ValidationError("No file uploaded");
  }
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    throw new ValidationError("Unsupported image type");
  }

  const existingUser = await userRepo().findOne({ where: { id: userId } });
  if (!existingUser) {
    throw new NotFoundError("Authenticated user no longer exists");
  }

  const asset = await replaceAsset(existingUser.profileImagePublicId ?? undefined, file.buffer, {
    folder: CLOUDINARY_FOLDERS.images,
    publicId: `${userId}-image`,
    mimetype: file.mimetype,
    resourceType: "image",
  });

  const updated = await userRepo().save({
    ...existingUser,
    profileImageUrl: asset.url,
    profileImagePublicId: asset.publicId,
  });

  return updated;
};
