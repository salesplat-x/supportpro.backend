import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { PreScreening } from "../entities/PreScreening.js";
import { User } from "../entities/User.js";
import { Role } from "../entities/Role.js";
import { TalentEmbedding } from "../entities/TalentEmbedding.js";
import { NotFoundError, ValidationError } from "../utils/errors";
import { PreScreeningStatus } from "../types/enums.js";
import {
  generatePreScreeningAssessment,
  scorePreScreeningAssessment,
  PreScreeningProfileContext,
} from "../utils/integrations/openai.js";
import { getProfileCompletion } from "./user.js";
import logger from "../utils/logger.js";

const preScreeningRepo = () => AppDataSource.getRepository(PreScreening);

const userRepo = () => AppDataSource.getRepository(User);

const roleRepo = () => AppDataSource.getRepository(Role);

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
  const roleValidation = await validateRoles(user);
  if (!roleValidation.valid) {
    throw new ValidationError("One or more selected roles do not exist in the role catalog");
  }

  const roleIds = (user.userRoles ?? []).map((r) => r.id);

  // Get CV text chunks from talent_embeddings
  const talentEmbeddings = await AppDataSource.getRepository(TalentEmbedding).find({
    where: { userId: user.id },
    select: { cvText: true },
  });
  const cvContent = talentEmbeddings.map((r) => r.cvText ?? "").join("\n\n");

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
      if (Array.isArray(candidate.questions) && count >= 5 && count <= 10) {
        parsed = { questions: candidate.questions };
        break;
      }
      logger.error(
        `Pre-screening attempt ${attempt} returned ${count} questions (expected 5–10) for user ${user.id}`
      );
    } catch {
      logger.error(
        `Pre-screening attempt ${attempt} returned unparseable content for user ${user.id}`
      );
    }
  }

  if (!parsed) {
    throw new ValidationError(
      "Failed to generate a valid assessment (5–10 questions). Please try again."
    );
  }

  const attemptCount = isRetake ? existingAttemptCount + 1 : 1;

  // Upsert pre_screening record
  let preScreening = await preScreeningRepo().findOne({ where: { userId: user.id } });

  if (preScreening) {
    preScreening.questions = parsed.questions;
    preScreening.roles = roleIds;
    preScreening.status = PreScreeningStatus.Pending;
    preScreening.attemptCount = attemptCount;
    preScreening.score = null;
    preScreening.completedAt = null;
    preScreening.generatedAt = new Date();
  } else {
    preScreening = preScreeningRepo().create({
      userId: user.id,
      roles: roleIds,
      questions: parsed.questions,
      status: PreScreeningStatus.Pending,
      attemptCount,
      maxAttempts: 2,
      generatedAt: new Date(),
    });
  }

  const saved = await preScreeningRepo().save(preScreening);

  // Update user's activePreScreeningId
  await userRepo().save({ ...user, activePreScreeningId: saved.id });
};

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

  if (!preScreening) {
    const { isProfileComplete } = getProfileCompletion(user);
    if (!isProfileComplete) {
      throw new NotFoundError("No assessment found. Complete your profile to generate one.");
    }
    // Fire-and-forget — client should poll until generating is false
    triggerPreScreeningGeneration(user);
    return {
      preScreening: {
        id: null,
        status: PreScreeningStatus.Pending,
        score: null,
        attemptCount: 0,
        maxAttempts: 2,
        generatedAt: new Date(),
        completedAt: null,
        roles: [],
        questions: [],
        generating: true,
      },
    };
  }

  const safeQuestions = stripSensitiveFields(preScreening.questions as IGeneratedQuestion[]);

  return {
    preScreening: {
      id: preScreening.id,
      status: preScreening.status,
      score: preScreening.score,
      attemptCount: preScreening.attemptCount,
      maxAttempts: preScreening.maxAttempts,
      generatedAt: preScreening.generatedAt,
      completedAt: preScreening.completedAt,
      roles: preScreening.roles,
      questions: safeQuestions,
    },
  };
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
    await userRepo().save({ ...user, prescreeningScore: totalScore });
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

  await generatePreScreeningForUser(user, true, preScreening.attemptCount);
};

// Fire-and-forget wrapper used from profile update hooks
export const triggerPreScreeningGeneration = (user: User): void => {
  generatePreScreeningForUser(user).catch((err: Error) =>
    logger.error(`Pre-screening generation failed for user ${user.id}: ${err?.message}`)
  );
};
