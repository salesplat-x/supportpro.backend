import { In, QueryFailedError } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { PreScreening } from "../entities/PreScreening.js";
import { User } from "../entities/User.js";
import { Role } from "../entities/Role.js";
import { TalentEmbedding } from "../entities/TalentEmbedding.js";
import { NotFoundError, ValidationError } from "../utils/errors";
import { GenerationStatus, PreScreeningStatus } from "../types/enums.js";
import {
  generatePreScreeningAssessment,
  scorePreScreeningAssessment,
  PreScreeningProfileContext,
} from "../utils/integrations/openai.js";
import { getProfileCompletion } from "./user.js";
import { advanceApplicationsAfterPrescreening } from "./applicationStage.js";
import logger from "../utils/logger.js";
import { redistributeCorrectOptions } from "../utils/generatedQuestions.js";
import {
  MAX_DURABLE_ATTEMPTS,
  STALE_LOCK_INTERVAL,
  SWEEP_BATCH_SIZE,
  claimRowById,
  durableFailureUpdate,
  selectDueIds,
} from "../utils/durableJobs.js";

export const PRESCREENING_SCORE_VALIDITY_DAYS = 90;

export const isPrescreeningScoreValid = (scoredAt: Date | null): boolean => {
  if (!scoredAt) return false;
  const expiresAt = new Date(scoredAt);
  expiresAt.setDate(expiresAt.getDate() + PRESCREENING_SCORE_VALIDITY_DAYS);
  return new Date() < expiresAt;
};

const preScreeningRepo = () => AppDataSource.getRepository(PreScreening);

const userRepo = () => AppDataSource.getRepository(User);

const roleRepo = () => AppDataSource.getRepository(Role);

const isUniqueViolation = (err: unknown): boolean => {
  if (!(err instanceof QueryFailedError)) return false;
  const code =
    (err as unknown as { code?: string }).code ??
    (err.driverError as { code?: string } | undefined)?.code;
  return code === "23505";
};

export interface IGeneratedQuestion {
  questionId: string;
  question: string;
  category: string;
  options: string[];
  correctOption: number;
  intent: string;
  scoringHint?: string;
}

export interface IPreScreeningAnswer {
  questionId: string;
  selectedOption: number;
}

const normalizeCorrectOption = (question: IGeneratedQuestion): number => {
  const { options } = question;
  const raw = question.correctOption as number | string;
  if (typeof raw === "number" && raw >= 0 && raw < options.length) {
    return raw;
  }
  if (typeof raw === "string") {
    const byText = options.indexOf(raw);
    if (byText >= 0) return byText;
  }
  return 0;
};

const stripSensitiveFields = (
  questions: IGeneratedQuestion[]
): Omit<IGeneratedQuestion, "correctOption" | "intent" | "scoringHint">[] =>
  questions.map(({ questionId, question, category, options }) => ({
    questionId,
    question,
    category,
    options,
  }));

const validateRoles = async (user: User): Promise<{ valid: boolean; names: string[] }> => {
  const roleIds = (user.userRoles ?? []).map((r) => r.id);
  if (roleIds.length === 0) return { valid: true, names: [] };
  const roles = await roleRepo().findBy({ id: In(roleIds) });
  if (roles.length !== roleIds.length) return { valid: false, names: [] };
  return { valid: true, names: roles.map((r) => r.name) };
};

export const generatePreScreeningForUser = async (
  user: User,
  isRetake = false,
  existingAttemptCount = 0
): Promise<void> => {
  const claimed = await claimRowById(CLAIM_PRESCREENING_SQL, user.id);
  if (!claimed) {
    if (isRetake) {
      throw new ValidationError("Assessment generation is already in progress. Please wait.");
    }
    return;
  }

  const roleValidation = await validateRoles(user);
  if (!roleValidation.valid) {
    await recordPreScreeningFailure(user.id, new Error("Invalid roles"), { permanent: true });
    throw new ValidationError("One or more selected roles do not exist in the role catalog");
  }

  const roleIds = (user.userRoles ?? []).map((r) => r.id);

  // Get CV text chunks from talent_embeddings
  const talentEmbeddings = await AppDataSource.getRepository(TalentEmbedding).find({
    where: { userId: user.id },
    select: { cvText: true },
  });
  const cvContent = talentEmbeddings.map((r) => r.cvText ?? "").join("\n\n");

  const existingPreScreening = await preScreeningRepo().findOne({ where: { userId: user.id } });

  const context: PreScreeningProfileContext = {
    bio: user.bio ?? undefined,
    roles: roleValidation.names,
    cvContent,
    experience: user.experience ?? undefined,
    workType: user.workType ?? undefined,
    location: user.locationCountry
      ? {
          city: user.locationCity ?? undefined,
          state: user.locationState ?? undefined,
          country: user.locationCountry ?? undefined,
        }
      : undefined,
    isRetake,
    previousQuestions:
      isRetake && existingPreScreening
        ? existingPreScreening.questions.map((q) => q.question)
        : undefined,
  };

  const MAX_GENERATION_ATTEMPTS = 3;
  let parsed: { questions: IGeneratedQuestion[] } | null = null;

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const result = await generatePreScreeningAssessment(context);
    if (!result?.message?.content) {
      logger.error(
        `Pre-screening generation attempt ${attempt} returned no content for user ${user.id}`
      );
      continue;
    }
    try {
      const candidate = JSON.parse(result.message.content) as {
        questions?: IGeneratedQuestion[];
      };
      const count = candidate.questions?.length ?? 0;
      const optionsValid =
        Array.isArray(candidate.questions) &&
        candidate.questions.every((q) => Array.isArray(q.options) && q.options.length === 4);
      if (Array.isArray(candidate.questions) && count >= 5 && count <= 10 && optionsValid) {
        parsed = {
          questions: redistributeCorrectOptions(
            candidate.questions.map((q) => ({ ...q, correctOption: normalizeCorrectOption(q) }))
          ),
        };
        break;
      }
      logger.error(
        `Pre-screening attempt ${attempt} returned ${count} questions (expected 5–10) or invalid option counts for user ${user.id}`
      );
    } catch {
      logger.error(
        `Pre-screening attempt ${attempt} returned unparseable content for user ${user.id}`
      );
    }
  }

  if (!parsed) {
    const err = new ValidationError(
      "Failed to generate a valid assessment (5–10 questions). Please try again."
    );
    await recordPreScreeningFailure(user.id, err);
    throw err;
  }

  const attemptCount = isRetake ? existingAttemptCount + 1 : 1;

  // Upsert pre_screening record
  let preScreening = existingPreScreening;

  if (preScreening) {
    preScreening.questions = parsed.questions;
    preScreening.roles = roleIds;
    preScreening.status = PreScreeningStatus.Pending;
    preScreening.attemptCount = attemptCount;
    preScreening.score = null;
    preScreening.completedAt = null;
    preScreening.generatedAt = new Date();
    preScreening.generationStatus = GenerationStatus.Succeeded;
    preScreening.generationLockedAt = null;
    preScreening.generationNextRetryAt = null;
    preScreening.generationLastError = null;
  } else {
    preScreening = preScreeningRepo().create({
      userId: user.id,
      roles: roleIds,
      questions: parsed.questions,
      status: PreScreeningStatus.Pending,
      attemptCount,
      maxAttempts: 2,
      generatedAt: new Date(),
      generationStatus: GenerationStatus.Succeeded,
    });
  }

  const saved = await preScreeningRepo().save(preScreening);

  // Update user's activePreScreeningId
  await userRepo().update(user.id, { activePreScreeningId: saved.id });
};

const CLAIM_PRESCREENING_SQL = `
  UPDATE "pre_screenings"
  SET "generationLockedAt" = NOW(),
      "generationStatus" = 'pending'
  WHERE "user_id" = $1
    AND "generationStatus" IN ('pending', 'failed')
    AND "generationAttempts" < ${MAX_DURABLE_ATTEMPTS}
    AND ("generationNextRetryAt" IS NULL OR "generationNextRetryAt" <= NOW())
    AND ("generationLockedAt" IS NULL OR "generationLockedAt" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  RETURNING "id"
`;

const DUE_PRESCREENING_SQL = `
  SELECT p."user_id" AS "id" FROM "pre_screenings" p
  WHERE p."generationStatus" IN ('pending', 'failed')
    AND p."generationAttempts" < $1
    AND ("generationNextRetryAt" IS NULL OR "generationNextRetryAt" <= NOW())
    AND ("generationLockedAt" IS NULL OR "generationLockedAt" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  LIMIT $2
`;

const recordPreScreeningFailure = async (
  userId: string,
  err: unknown,
  options: { permanent?: boolean } = {}
): Promise<void> => {
  const row = await preScreeningRepo().findOne({
    where: { userId },
    select: { id: true, generationAttempts: true },
  });
  if (!row) return;
  const currentAttempts = row.generationAttempts ?? 0;
  const patch = options.permanent
    ? {
        attempts: MAX_DURABLE_ATTEMPTS,
        nextRetryAt: null as Date | null,
        lockedAt: null,
        lastError: err instanceof Error ? err.message : String(err),
        exhausted: true,
      }
    : durableFailureUpdate(currentAttempts, err);

  await preScreeningRepo().update(row.id, {
    generationStatus: patch.exhausted ? GenerationStatus.Failed : GenerationStatus.Pending,
    generationAttempts: patch.attempts,
    generationNextRetryAt: patch.nextRetryAt,
    generationLockedAt: patch.lockedAt,
    generationLastError: patch.lastError,
  });
};

const ensurePendingStub = async (
  user: User,
  options: { reset?: boolean } = {}
): Promise<{ row: PreScreening; created: boolean }> => {
  const roleIds = (user.userRoles ?? []).map((r) => r.id);
  const existing = await preScreeningRepo().findOne({ where: { userId: user.id } });

  if (existing && !options.reset) {
    return { row: existing, created: false };
  }

  if (existing && options.reset) {
    existing.questions = [];
    existing.roles = roleIds;
    existing.status = PreScreeningStatus.Pending;
    existing.score = null;
    existing.completedAt = null;
    existing.generatedAt = new Date();
    existing.generationStatus = GenerationStatus.Pending;
    existing.generationAttempts = 0;
    existing.generationNextRetryAt = null;
    existing.generationLockedAt = null;
    existing.generationLastError = null;
    return { row: await preScreeningRepo().save(existing), created: false };
  }

  try {
    const stub = preScreeningRepo().create({
      userId: user.id,
      roles: roleIds,
      questions: [],
      status: PreScreeningStatus.Pending,
      attemptCount: 0,
      maxAttempts: 2,
      generatedAt: new Date(),
      generationStatus: GenerationStatus.Pending,
      generationAttempts: 0,
    });
    const saved = await preScreeningRepo().save(stub);
    await userRepo().update(user.id, { activePreScreeningId: saved.id });
    return { row: saved, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const row = await preScreeningRepo().findOne({ where: { userId: user.id } });
    if (!row) throw err;
    return { row, created: false };
  }
};

const toClientPreScreening = (
  preScreening: PreScreening,
  extras: { generating?: boolean; generationFailed?: boolean } = {}
) => ({
  id: preScreening.id,
  status: preScreening.status,
  score: preScreening.score,
  attemptCount: preScreening.attemptCount,
  maxAttempts: preScreening.maxAttempts,
  generatedAt: preScreening.generatedAt,
  completedAt: preScreening.completedAt,
  roles: preScreening.roles,
  questions:
    extras.generating || extras.generationFailed
      ? []
      : stripSensitiveFields(preScreening.questions as IGeneratedQuestion[]),
  ...extras,
});

export const getActivePreScreening = async (
  userId: string
): Promise<{
  preScreening: {
    id: string | null;
    status: PreScreeningStatus;
    score: number | null;
    attemptCount: number;
    maxAttempts: number;
    generatedAt: Date;
    completedAt: Date | null;
    roles: string[];
    questions: ReturnType<typeof stripSensitiveFields>;
    generating?: boolean;
    generationFailed?: boolean;
  };
}> => {
  const user = await userRepo().findOne({
    where: { id: userId },
    relations: { userRoles: true },
  });
  if (!user) {
    throw new NotFoundError("User not found");
  }

  const preScreening = await preScreeningRepo().findOne({ where: { userId } });

  const scoreExpired =
    !!preScreening &&
    preScreening.status === PreScreeningStatus.Completed &&
    !isPrescreeningScoreValid(user.prescreeningScoredAt);

  if (!preScreening || scoreExpired) {
    const { isProfileComplete } = getProfileCompletion(user);
    if (!isProfileComplete) {
      throw new NotFoundError("No assessment found. Complete your profile to generate one.");
    }
    const { row, created } = await ensurePendingStub(user, { reset: scoreExpired });
    if (created || scoreExpired) {
      triggerPreScreeningGeneration(user);
    }
    return { preScreening: toClientPreScreening(row, { generating: true }) };
  }

  if (preScreening.generationStatus === GenerationStatus.Pending) {
    return { preScreening: toClientPreScreening(preScreening, { generating: true }) };
  }

  if (preScreening.generationStatus === GenerationStatus.Failed) {
    return { preScreening: toClientPreScreening(preScreening, { generationFailed: true }) };
  }

  return { preScreening: toClientPreScreening(preScreening) };
};

export const submitPreScreeningAnswers = async (
  userId: string,
  answers: IPreScreeningAnswer[] | Record<string, string>
): Promise<{
  score: number;
  breakdown: unknown[];
  attemptCount: number;
  maxAttempts: number;
}> => {
  const preScreening = await preScreeningRepo().findOne({ where: { userId } });
  if (!preScreening) {
    throw new NotFoundError("No active assessment found");
  }
  if (preScreening.status === PreScreeningStatus.Completed) {
    throw new ValidationError("Assessment already completed. Use retake to attempt again.");
  }
  if (
    preScreening.generationStatus !== GenerationStatus.Succeeded ||
    (preScreening.questions as IGeneratedQuestion[]).length === 0
  ) {
    throw new ValidationError("Assessment questions are not ready yet. Please wait and try again.");
  }

  const storedQuestions = preScreening.questions as IGeneratedQuestion[];

  // Normalise object format { [questionId]: optionText } → IPreScreeningAnswer[]
  let normalised: IPreScreeningAnswer[];
  if (Array.isArray(answers)) {
    normalised = answers;
  } else {
    const questionMap = new Map(storedQuestions.map((q) => [q.questionId, q]));
    const invalid: string[] = [];
    normalised = Object.entries(answers).map(([questionId, optionText]) => {
      const question = questionMap.get(questionId);
      const selectedOption = question ? question.options.indexOf(optionText) : -1;
      if (selectedOption === -1) invalid.push(questionId);
      return { questionId, selectedOption };
    });
    if (invalid.length > 0) {
      throw new ValidationError(`Invalid option text for question(s): ${invalid.join(", ")}`);
    }
  }

  const answerMap = new Map(normalised.map((a) => [a.questionId, a.selectedOption]));
  const missingQuestions = storedQuestions.filter((q) => !answerMap.has(q.questionId));
  if (missingQuestions.length > 0) {
    throw new ValidationError(`Missing answers for ${missingQuestions.length} question(s)`);
  }

  const user = await userRepo().findOne({
    where: { id: userId },
    relations: { userRoles: true },
  });

  const cvRows: Array<{ cv_text: string }> = await AppDataSource.query(
    "SELECT cv_text FROM talent_embeddings WHERE user_id = $1",
    [userId]
  );
  const cvContent = cvRows.map((r) => r.cv_text).join("\n\n");

  let roleNames: string[] = preScreening.roles;
  if (user?.userRoles?.length) {
    const ids = user.userRoles.map((r) => r.id);
    const roles = await roleRepo().findBy({ id: In(ids) });
    roleNames = roles.map((r) => r.name);
  }

  const scoringQuestions = storedQuestions.map((q) => ({
    ...q,
    selectedOption: answerMap.get(q.questionId) ?? -1,
  }));

  const profileContext: PreScreeningProfileContext = {
    bio: user?.bio ?? undefined,
    roles: roleNames,
    cvContent,
    experience: user?.experience ?? undefined,
    workType: user?.workType ?? undefined,
    location: user?.locationCountry
      ? {
          city: user.locationCity ?? undefined,
          state: user.locationState ?? undefined,
          country: user.locationCountry ?? undefined,
        }
      : undefined,
  };

  const scoringResult = await scorePreScreeningAssessment({
    questions: scoringQuestions,
    profileContext,
  });

  if (!scoringResult?.message?.content) {
    throw new ValidationError("Failed to score assessment");
  }

  let scored: { totalScore: number; breakdown: unknown[] };
  try {
    scored = JSON.parse(scoringResult.message.content) as typeof scored;
  } catch {
    throw new ValidationError("Scoring returned invalid data");
  }

  const totalScore = Math.min(100, Math.max(0, Number(scored.totalScore) || 0));

  // Mark prescreening completed
  preScreening.status = PreScreeningStatus.Completed;
  preScreening.score = totalScore;
  preScreening.completedAt = new Date();
  await preScreeningRepo().save(preScreening);

  // Update user's prescreeningScore
  if (user) {
    await userRepo().update(user.id, {
      prescreeningScore: totalScore,
      prescreeningScoredAt: new Date(),
    });
    // Advance every application currently parked at the Prescreening stage for this
    // talent — Pre-Assessment is a single global test reused across all jobs.
    await advanceApplicationsAfterPrescreening(user, totalScore);
  }

  return {
    score: totalScore,
    breakdown: scored.breakdown,
    attemptCount: preScreening.attemptCount,
    maxAttempts: preScreening.maxAttempts,
  };
};

export const retakePreScreening = async (userId: string): Promise<void> => {
  const preScreening = await preScreeningRepo().findOne({ where: { userId } });
  if (!preScreening) {
    throw new NotFoundError("No assessment found");
  }
  if (preScreening.status !== PreScreeningStatus.Completed) {
    throw new ValidationError(
      "You must complete your current assessment before requesting a retake"
    );
  }
  if (preScreening.attemptCount >= preScreening.maxAttempts) {
    throw new ValidationError(
      `Attempt limit reached. You have used ${preScreening.attemptCount} / ${preScreening.maxAttempts} attempts.`
    );
  }

  const user = await userRepo().findOne({
    where: { id: userId },
    relations: { userRoles: true },
  });
  if (!user) {
    throw new NotFoundError("User not found");
  }

  await preScreeningRepo().update(preScreening.id, {
    generationStatus: GenerationStatus.Pending,
    generationAttempts: 0,
    generationNextRetryAt: null,
    generationLockedAt: null,
    generationLastError: null,
  });
  await generatePreScreeningForUser(user, true, preScreening.attemptCount);
};

export const triggerPreScreeningGeneration = (user: User): void => {
  void ensurePendingStub(user, { reset: true })
    .then(() => generatePreScreeningForUser(user))
    .catch((err: unknown) =>
      logger.error(
        `Pre-screening generation failed for user ${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    );
};

export const retryPreScreeningGeneration = async (userId: string): Promise<void> => {
  const user = await userRepo().findOne({
    where: { id: userId },
    relations: { userRoles: true },
  });
  if (!user) {
    throw new NotFoundError("User not found");
  }

  const preScreening = await preScreeningRepo().findOne({ where: { userId } });
  if (!preScreening) {
    throw new NotFoundError("No assessment found");
  }
  if (preScreening.generationStatus !== GenerationStatus.Failed) {
    throw new ValidationError("Assessment generation is not in a failed state");
  }

  triggerPreScreeningGeneration(user);
};

export const reconcileDuePreScreeningGenerations = async (): Promise<{
  scanned: number;
  attempted: number;
}> => {
  const userIds = await selectDueIds(DUE_PRESCREENING_SQL, [
    MAX_DURABLE_ATTEMPTS,
    SWEEP_BATCH_SIZE,
  ]);
  for (const userId of userIds) {
    const user = await userRepo().findOne({
      where: { id: userId },
      relations: { userRoles: true },
    });
    if (!user) continue;
    try {
      await generatePreScreeningForUser(user);
    } catch (err) {
      logger.error(
        `Pre-screening reconciliation failed for user ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return { scanned: userIds.length, attempted: userIds.length };
};
