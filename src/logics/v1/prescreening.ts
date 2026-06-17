import { IUser, IProfile } from "../../typings/user";
import { IPreScreeningAnswer, IGeneratedQuestion } from "../../typings/prescreening";
import { IRole } from "../../typings/role";
import { makeResponse } from "../../helpers/response";
import * as prescreeningRepository from "../../repository/v1/prescreening";
import * as roleRepository from "../../repository/v1/role";
import * as userRepository from "../../repository/v1/user";
import { getCvTextByProfileId } from "../../repository/v1/pg";
import {
  generatePreScreeningAssessment,
  scorePreScreeningAssessment,
  PreScreeningProfileContext,
} from "../../services/v1/openai";
import logger from "../../config/logger";

const stripSensitiveFields = (questions: IGeneratedQuestion[]) =>
  questions.map(({ questionId, question, category, options }) => ({
    questionId,
    question,
    category,
    options,
  }));

const buildProfileContext = (
  profile: IProfile,
  roleNames: string[],
  cvContent: string,
  isRetake = false
): PreScreeningProfileContext => ({
  bio: profile.bio,
  roles: roleNames,
  cvContent,
  experience: profile.experience,
  workType: profile.workType ?? undefined,
  location: profile.location,
  isRetake,
});

const validateRoles = async (
  roles: IProfile["role"]
): Promise<{ valid: boolean; names: string[] }> => {
  const names: string[] = [];
  for (const roleRef of roles) {
    const id = (roleRef as IRole)?._id ?? roleRef;
    const role = await roleRepository.findRoleById(id as string);
    if (!role) return { valid: false, names: [] };
    names.push(role.name);
  }
  return { valid: true, names };
};

export const generatePreScreeningForUser = async (
  user: IUser,
  profile: IProfile,
  isRetake = false,
  existingAttemptCount = 0
) => {
  const roleValidation = await validateRoles(profile.role);
  if (!roleValidation.valid) {
    return makeResponse(
      false,
      "One or more selected roles do not exist in the role catalog",
      {},
      400
    );
  }

  const roleIds = [...profile.role].map((r) => {
    const id = (r as IRole)?._id ?? r;
    return id.toString();
  });

  const cvChunks = await getCvTextByProfileId(profile._id.toString());
  const cvContent = cvChunks.join("\n\n");

  const context = buildProfileContext(profile, roleValidation.names, cvContent, isRetake);

  const MAX_GENERATION_ATTEMPTS = 3;
  let parsed: { questions: IGeneratedQuestion[] } | null = null;

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const result = await generatePreScreeningAssessment(context);
    if (!result?.message?.content) {
      logger.logErrorMessage(
        `Pre-screening generation attempt ${attempt} returned no content for user ${user._id}`
      );
      continue;
    }
    try {
      const candidate = JSON.parse(result.message.content);
      const count = candidate.questions?.length ?? 0;
      if (Array.isArray(candidate.questions) && count >= 5 && count <= 10) {
        parsed = candidate;
        break;
      }
      logger.logErrorMessage(
        `Pre-screening attempt ${attempt} returned ${count} questions (expected 5–10) for user ${user._id}`
      );
    } catch {
      logger.logErrorMessage(
        `Pre-screening attempt ${attempt} returned unparseable content for user ${user._id}`
      );
    }
  }

  if (!parsed) {
    return makeResponse(
      false,
      "Failed to generate a valid assessment (5–10 questions). Please try again.",
      {},
      500
    );
  }

  const attemptCount = isRetake ? existingAttemptCount + 1 : 1;

  const preScreening = await prescreeningRepository.upsertPreScreening(
    user._id,
    roleIds,
    parsed.questions,
    attemptCount
  );

  await userRepository.findProfileByIdAndUpdate(profile._id, {
    activePreScreening: preScreening._id,
  });

  return makeResponse(true, "Assessment generated successfully", {});
};

export const getActivePreScreening = async (user: IUser) => {
  const existingUser = await userRepository.findUserById(user._id);
  if (!existingUser) {
    return makeResponse(false, "User not found", {}, 404);
  }

  const profile = existingUser.profile as IProfile | undefined;
  if (!profile) {
    return makeResponse(false, "Profile not found", {}, 404);
  }

  let preScreening = await prescreeningRepository.findPreScreeningByUserId(user._id);
  if (!preScreening) {
    if (!profile.isProfileComplete) {
      return makeResponse(
        false,
        "No assessment found. Complete your profile to generate one.",
        {},
        404
      );
    }
    const generated = await generatePreScreeningForUser(user, profile);
    if (!generated.status) return generated;
    preScreening = await prescreeningRepository.findPreScreeningByUserId(user._id);
    if (!preScreening) {
      return makeResponse(false, "Failed to generate assessment. Please try again.", {}, 500);
    }
  }

  const safeQuestions = stripSensitiveFields(preScreening.questions);

  return makeResponse(true, "Assessment fetched successfully", {
    preScreening: {
      _id: preScreening._id,
      status: preScreening.status,
      score: preScreening.score,
      attemptCount: preScreening.attemptCount,
      maxAttempts: preScreening.maxAttempts,
      generatedAt: preScreening.generatedAt,
      completedAt: preScreening.completedAt,
      roles: preScreening.roles,
      questions: safeQuestions,
    },
  });
};

export const submitPreScreeningAnswers = async (
  user: IUser,
  answers: IPreScreeningAnswer[] | Record<string, string>
) => {
  const preScreening = await prescreeningRepository.findPreScreeningByUserId(user._id);
  if (!preScreening) {
    return makeResponse(false, "No active assessment found", {}, 404);
  }
  if (preScreening.status === "completed") {
    return makeResponse(
      false,
      "Assessment already completed. Use retake to attempt again.",
      {},
      422
    );
  }

  // Normalise object format { [questionId]: optionText } → IPreScreeningAnswer[]
  let normalised: IPreScreeningAnswer[];
  if (Array.isArray(answers)) {
    normalised = answers;
  } else {
    const questionMap = new Map(preScreening.questions.map((q) => [q.questionId, q]));
    const invalid: string[] = [];
    normalised = Object.entries(answers).map(([questionId, optionText]) => {
      const question = questionMap.get(questionId);
      const selectedOption = question ? question.options.indexOf(optionText) : -1;
      if (selectedOption === -1) invalid.push(questionId);
      return { questionId, selectedOption };
    });
    if (invalid.length > 0) {
      return makeResponse(
        false,
        `Invalid option text for question(s): ${invalid.join(", ")}`,
        {},
        400
      );
    }
  }

  const answerMap = new Map(normalised.map((a) => [a.questionId, a.selectedOption]));
  const missingQuestions = preScreening.questions.filter((q) => !answerMap.has(q.questionId));
  if (missingQuestions.length > 0) {
    return makeResponse(
      false,
      `Missing answers for ${missingQuestions.length} question(s)`,
      {},
      400
    );
  }

  const existingUser = await userRepository.findUserById(user._id);
  const profile = existingUser?.profile as IProfile | undefined;

  const cvChunks = profile ? await getCvTextByProfileId(profile._id.toString()) : [];
  const cvContent = cvChunks.join("\n\n");

  const roleNames = profile?.role
    ? await Promise.all(
        [...profile.role].map(async (r) => {
          const id = ((r as IRole)?._id ?? r) as string;
          const role = await roleRepository.findRoleById(id);
          return role?.name ?? id;
        })
      )
    : preScreening.roles;

  const scoringQuestions = preScreening.questions.map((q) => ({
    ...q,
    selectedOption: answerMap.get(q.questionId) ?? -1,
  }));

  const profileContext: PreScreeningProfileContext = {
    bio: profile?.bio,
    roles: roleNames,
    cvContent,
    experience: profile?.experience,
    workType: profile?.workType ?? undefined,
    location: profile?.location,
  };

  const scoringResult = await scorePreScreeningAssessment({
    questions: scoringQuestions,
    profileContext,
  });

  if (!scoringResult?.message?.content) {
    return makeResponse(false, "Failed to score assessment", {}, 500);
  }

  let scored: { totalScore: number; breakdown: unknown[] };
  try {
    scored = JSON.parse(scoringResult.message.content);
  } catch {
    return makeResponse(false, "Scoring returned invalid data", {}, 500);
  }

  const totalScore = Math.min(100, Math.max(0, Number(scored.totalScore) || 0));

  const updated = await prescreeningRepository.markPreScreeningCompleted(
    preScreening._id,
    totalScore
  );

  const profileIdForScore =
    profile?._id ?? (preScreening.userId as any)?._id ?? preScreening.userId;

  await userRepository.findProfileByIdAndUpdate(profileIdForScore, {
    prescreeningScore: totalScore,
  });

  return makeResponse(true, "Assessment submitted and scored", {
    score: totalScore,
    breakdown: scored.breakdown,
    attemptCount: updated?.attemptCount,
    maxAttempts: updated?.maxAttempts,
  });
};

export const retakePreScreening = async (user: IUser) => {
  const preScreening = await prescreeningRepository.findPreScreeningByUserId(user._id);
  if (!preScreening) {
    return makeResponse(false, "No assessment found", {}, 404);
  }
  if (preScreening.status !== "completed") {
    return makeResponse(
      false,
      "You must complete your current assessment before requesting a retake",
      {},
      422
    );
  }
  if (preScreening.attemptCount >= preScreening.maxAttempts) {
    return makeResponse(
      false,
      `Attempt limit reached. You have used ${preScreening.attemptCount} / ${preScreening.maxAttempts} attempts.`,
      {},
      422
    );
  }

  const existingUser = await userRepository.findUserById(user._id);
  if (!existingUser) {
    return makeResponse(false, "User not found", {}, 404);
  }

  const profile = existingUser.profile as IProfile | undefined;
  if (!profile) {
    return makeResponse(false, "Profile not found", {}, 404);
  }

  return generatePreScreeningForUser(user, profile, true, preScreening.attemptCount);
};

// Fire-and-forget wrapper used from profile update hooks
export const triggerPreScreeningGeneration = (user: IUser, profile: IProfile) => {
  generatePreScreeningForUser(user, profile).catch((err) =>
    logger.logErrorMessage(`Pre-screening generation failed for user ${user._id}: ${err?.message}`)
  );
};
