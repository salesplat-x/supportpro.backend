import { MAX_ANSWER_SCORE } from "../utils/gradedAnswers.js";
import { Not, IsNull, In, type FindOptionsRelations } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { AIConfig } from "../entities/AIConfig.js";
import { Application } from "../entities/Application.js";
import { AiRecommendation } from "../entities/AiRecommendation.js";
import { Job } from "../entities/Job.js";
import { User } from "../entities/User.js";
import { Answer } from "../entities/Answer.js";
import { Question } from "../entities/Question.js";
import { TalentEmbedding } from "../entities/TalentEmbedding.js";
import {
  ApplicationStatus,
  ScreeningStage,
  MatchVerdict,
  MatchVerdictStatus,
  MatchRecommendation,
  QuestionType,
} from "../types/enums.js";
import {
  MAX_DURABLE_ATTEMPTS,
  STALE_LOCK_INTERVAL,
  SWEEP_BATCH_SIZE,
  claimRowById,
  durableFailureUpdate,
  selectDueIds,
} from "../utils/durableJobs.js";
import { ValidationError } from "../utils/errors";
import { assessApplicationMatch } from "../utils/integrations/openai.js";
import {
  parseMatchAnalysis,
  scoreFromVerdict,
  type MatchAnalysis,
} from "../utils/matchAnalysis.js";
import { isPrescreeningScoreValid } from "./prescreening.js";
import {
  answerTextForQuestion,
  storedResponseQuestionId,
  type StoredResponse,
} from "../utils/answerResponses.js";
import logger from "../utils/logger.js";
import { convertSimilarityToPercentage } from "../utils/text.js";

const applicationRepo = () => AppDataSource.getRepository(Application);

const aiRecommendationRepo = () => AppDataSource.getRepository(AiRecommendation);

const jobRepo = () => AppDataSource.getRepository(Job);

const answerRepo = () => AppDataSource.getRepository(Answer);

const questionRepo = () => AppDataSource.getRepository(Question);

const talentEmbeddingRepo = () => AppDataSource.getRepository(TalentEmbedding);

const userRepo = () => AppDataSource.getRepository(User);

const CV_SIMILARITY_MAX_ATTEMPTS = 2;

export type QuestionAnswerPair = {
  question: string;
  answer: string;
  dichotomy?: string;
};

// Joins an Answer row's responses back to their question text so the LLM gets
// readable Q&A pairs instead of opaque question IDs.
export const buildQuestionAnswerPairs = async (
  jobId: string,
  userId: string,
  questionType: QuestionType.Personalized | QuestionType.Personality
): Promise<QuestionAnswerPair[]> => {
  const answer = await answerRepo().findOne({ where: { userId, jobId, questionType } });
  if (!answer || answer.responses.length === 0) return [];

  const questions = await questionRepo().find({ where: { jobId, type: questionType } });
  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const responses = answer.responses as StoredResponse[];

  return responses.map((r, index) => {
    const responseId = storedResponseQuestionId(r);
    const question =
      (responseId ? questionsById.get(responseId) : undefined) ??
      questions.find((q) => q.question === r.question) ??
      questions[index];
    return {
      question: question?.question ?? (r.question && !responseId ? r.question : "Unknown question"),
      answer:
        answerTextForQuestion(
          responses,
          question?.id ?? responseId ?? "",
          question?.question,
          index
        ) ??
        r.answer ??
        "",
      ...(question?.criteria ? { dichotomy: question.criteria } : {}),
    };
  });
};

export type GradedAnswerPair = {
  question: string;
  answer: string;
  score: number | null;
  maxScore: number;
  feedback: string | null;
};

type StoredGradedResponse = {
  questionId?: string;
  answer?: string;
  score?: number;
  feedback?: string;
};

export const buildGradedAnswerPairs = async (
  jobId: string,
  userId: string,
  questionType: QuestionType.ProblemSolving | QuestionType.CultureFit
): Promise<GradedAnswerPair[]> => {
  const answer = await answerRepo().findOne({ where: { userId, jobId, questionType } });
  if (!answer || answer.responses.length === 0) return [];

  const responses = answer.responses as StoredGradedResponse[];
  const ids = responses.map((r) => r.questionId).filter((id): id is string => !!id);
  const questions = ids.length ? await questionRepo().find({ where: { id: In(ids) } }) : [];
  const questionsById = new Map(questions.map((q) => [q.id, q.question]));

  return responses.map((r) => ({
    question: (r.questionId && questionsById.get(r.questionId)) || "Unknown question",
    answer: r.answer ?? "",
    score: typeof r.score === "number" ? r.score : null,
    maxScore: MAX_ANSWER_SCORE,
    feedback: r.feedback ?? null,
  }));
};

const persistRecommendation = async (
  applicationId: string,
  payload: {
    verdict: MatchVerdict;
    reasoning: string;
    recommendation: MatchRecommendation | null;
    strengths: string[] | null;
    weaknesses: string[] | null;
    risks: string[] | null;
    analysis: MatchAnalysis | null;
  }
): Promise<void> => {
  // The AI Match column/ring shows this — fall back to a verdict-derived score
  // (same mapping parseMatchAnalysis uses) so it's never blank when a verdict
  // exists but structured analysis doesn't (e.g. the legacy direct-write path).
  const overallFitScore = payload.analysis?.overallFitScore ?? scoreFromVerdict(payload.verdict);

  // Both writes must land together — a partial write here is exactly what lets
  // ai_recommendations and the denormalized Application columns drift apart.
  await AppDataSource.transaction(async (manager) => {
    const existing = await manager.findOne(AiRecommendation, { where: { applicationId } });
    if (existing) {
      // Generated once — never overwrite a stored recommendation.
      return;
    }

    await manager.save(
      AiRecommendation,
      manager.create(AiRecommendation, { applicationId, ...payload })
    );

    // Keep denormalized columns on applications in sync for existing API consumers.
    await manager.update(Application, applicationId, {
      matchVerdict: payload.verdict,
      matchVerdictStatus: MatchVerdictStatus.Succeeded,
      matchVerdictReasoning: payload.reasoning,
      matchRecommendation: payload.recommendation,
      matchStrengths: payload.strengths,
      matchWeaknesses: payload.weaknesses,
      matchRisks: payload.risks,
      overallFitScore,
      matchVerdictLockedAt: null,
      matchVerdictNextRetryAt: null,
      matchVerdictLastError: null,
    });
  });
};

// ai_recommendations is the source of truth; these columns on Application are a
// denormalized cache for existing consumers. Use these helpers on every read path
// so a row that drifted (e.g. from a pre-transaction partial write) still shows
// correct, consistent data instead of a stale/blank matchVerdict.
export const overlayVerdictFromRecommendation = <T extends Application>(
  application: T,
  recommendation: AiRecommendation | null | undefined
): T => {
  if (!recommendation) return application;
  application.matchVerdict = recommendation.verdict;
  application.matchVerdictStatus = MatchVerdictStatus.Succeeded;
  application.matchVerdictReasoning = recommendation.reasoning;
  application.matchRecommendation = recommendation.recommendation;
  application.matchStrengths = recommendation.strengths;
  application.matchWeaknesses = recommendation.weaknesses;
  application.matchRisks = recommendation.risks;
  application.overallFitScore =
    recommendation.analysis?.overallFitScore ?? scoreFromVerdict(recommendation.verdict);
  Object.assign(application, { matchAnalysis: recommendation.analysis ?? null });
  return application;
};

export const loadApplicationWithMatch = async (
  applicationId: string,
  relations: FindOptionsRelations<Application> = {}
): Promise<Application | null> => {
  const application = await applicationRepo().findOne({ where: { id: applicationId }, relations });
  if (!application) return null;
  const recommendation = await aiRecommendationRepo().findOne({ where: { applicationId } });
  return overlayVerdictFromRecommendation(application, recommendation);
};

export const loadRecommendationsByApplicationIds = async (
  applicationIds: string[]
): Promise<Map<string, AiRecommendation>> => {
  if (applicationIds.length === 0) return new Map();
  const recommendations = await aiRecommendationRepo().find({
    where: { applicationId: In(applicationIds) },
  });
  return new Map(recommendations.map((r) => [r.applicationId, r]));
};

export const canTakeAssessment = (assessmentRetryDate: Date | null): boolean => {
  if (!assessmentRetryDate) return true;
  return new Date() >= assessmentRetryDate;
};

export const getAssessmentRetryDate = (days = 7): Date => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};

// `rank` is sequential completion order (the Nth applicant to finish the
// pipeline), not a quality ranking — the AI match verdict is what represents
// quality, and that's what the applicant table sorts by default. Don't
// conflate the two: a low rank number just means they finished early.
export const rankApplication = async (
  talent: User,
  application: Application,
  aiConfig?: Pick<
    AIConfig,
    "cvSimilarity" | "personalizedAssessment" | "prescreeningAssessment"
  > | null
): Promise<void> => {
  const prescreeningScore = isPrescreeningScoreValid(talent.prescreeningScoredAt)
    ? (talent.prescreeningScore ?? undefined)
    : undefined;
  // Without an aiConfig to check against, fall back to including whatever
  // scores are present (previous behavior) rather than guessing.
  const includeCv = aiConfig ? aiConfig.cvSimilarity : true;
  const includePersonalized = aiConfig ? aiConfig.personalizedAssessment : true;
  const includePrescreening = aiConfig ? aiConfig.prescreeningAssessment : true;

  const scores = [
    includeCv ? application.cvSimilarityScore : undefined,
    includePersonalized ? application.personalizedScore : undefined,
    includePrescreening ? prescreeningScore : undefined,
  ].filter((s): s is number => s !== null && s !== undefined);

  application.averageScore =
    scores.length > 0
      ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2))
      : null;

  // Only count applications that have *already* been ranked (i.e. already
  // finished the pipeline) — counting every application for the job, as this
  // used to, includes talents still mid-pipeline and inflates rank past the
  // number of applicants who've actually completed (e.g. "rank 3 of 2").
  const newRank =
    (await applicationRepo().count({
      where: { jobId: application.jobId, rank: Not(IsNull()) },
    })) + 1;

  application.rank = newRank;
};

export interface TriggerMatchVerdictOptions {
  /** @deprecated Match is generated once. Ignored if a recommendation already exists. */
  force?: boolean;
}

const CLAIM_MATCH_VERDICT_SQL = `
  UPDATE "applications"
  SET "matchVerdictLockedAt" = NOW(),
      "matchVerdictStatus" = 'pending'
  WHERE "id" = $1
    AND "matchVerdict" IS NULL
    AND "matchVerdictAttempts" < ${MAX_DURABLE_ATTEMPTS}
    AND ("matchVerdictNextRetryAt" IS NULL OR "matchVerdictNextRetryAt" <= NOW())
    AND ("matchVerdictLockedAt" IS NULL OR "matchVerdictLockedAt" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  RETURNING "id"
`;

const DUE_MATCH_VERDICT_SQL = `
  SELECT "id" FROM "applications"
  WHERE "currentStage" = 'completed'
    AND "matchVerdict" IS NULL
    AND ("matchVerdictStatus" IS NULL OR "matchVerdictStatus" IN ('pending', 'failed'))
    AND "matchVerdictAttempts" < $1
    AND ("matchVerdictNextRetryAt" IS NULL OR "matchVerdictNextRetryAt" <= NOW())
    AND ("matchVerdictLockedAt" IS NULL OR "matchVerdictLockedAt" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  LIMIT $2
`;

const recordMatchVerdictFailure = async (
  applicationId: string,
  err: unknown,
  options: { permanent?: boolean } = {}
): Promise<void> => {
  try {
    const row = await applicationRepo().findOne({
      where: { id: applicationId },
      select: { id: true, matchVerdictAttempts: true },
    });
    const currentAttempts = row?.matchVerdictAttempts ?? 0;
    const patch = options.permanent
      ? {
          attempts: MAX_DURABLE_ATTEMPTS,
          nextRetryAt: null as Date | null,
          lockedAt: null,
          lastError: err instanceof Error ? err.message : String(err),
          exhausted: true,
        }
      : durableFailureUpdate(currentAttempts, err);

    await applicationRepo().update(applicationId, {
      matchVerdictStatus: patch.exhausted ? MatchVerdictStatus.Failed : MatchVerdictStatus.Pending,
      matchVerdictAttempts: patch.attempts,
      matchVerdictNextRetryAt: patch.nextRetryAt,
      matchVerdictLockedAt: patch.lockedAt,
      matchVerdictLastError: patch.lastError,
    });
  } catch (recordErr) {
    logger.error(
      `Failed to record match verdict failure for application ${applicationId}: ${
        recordErr instanceof Error ? recordErr.message : String(recordErr)
      }`
    );
  }
};

const inFlightMatchVerdicts = new Set<Promise<void>>();

/** Await fire-and-forget match verdict work before tearing down the test DB. */
export const drainInFlightMatchVerdicts = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100 && inFlightMatchVerdicts.size > 0; attempt++) {
    await Promise.allSettled([...inFlightMatchVerdicts]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const overlayExistingRecommendation = async (
  application: Application,
  existing: AiRecommendation
): Promise<void> => {
  await applicationRepo().update(application.id, {
    matchVerdict: existing.verdict,
    matchVerdictStatus: MatchVerdictStatus.Succeeded,
    matchVerdictReasoning: existing.reasoning,
    matchRecommendation: existing.recommendation,
    matchStrengths: existing.strengths,
    matchWeaknesses: existing.weaknesses,
    matchRisks: existing.risks,
    overallFitScore: existing.analysis?.overallFitScore ?? scoreFromVerdict(existing.verdict),
    matchVerdictLockedAt: null,
    matchVerdictNextRetryAt: null,
    matchVerdictLastError: null,
  });
};

// Advisory only — never blocks the actual stage transition. Callers fire this
// without awaiting it so it doesn't delay the response; failures (including a
// missing/unparsable LLM response) are logged and swallowed rather than surfaced
// to the talent. Exported `async` (rather than void-returning) so tests can await
// it directly instead of racing the fire-and-forget call.
//
// Recommendations are persisted in `ai_recommendations` and generated once.
// Viewing an applicant reads the stored row — it never recomputes. Recruiter
// retry resets attempt counters and re-enqueues; the in-process sweep retries
// pending work automatically.
const executeTriggerMatchVerdict = async (
  talent: User,
  application: Application,
  _options: TriggerMatchVerdictOptions = {}
): Promise<void> => {
  try {
    // Yield so the caller can persist stage/status columns before this runs
    // (processNextStage is fire-and-forget, then the caller saves).
    await new Promise<void>((resolve) => setImmediate(resolve));

    const existingRecommendation = await aiRecommendationRepo().findOne({
      where: { applicationId: application.id },
    });

    if (existingRecommendation) {
      if (!application.matchVerdict) {
        await overlayExistingRecommendation(application, existingRecommendation);
      }
      return;
    }

    if (application.matchVerdict) {
      await persistRecommendation(application.id, {
        verdict: application.matchVerdict,
        reasoning: application.matchVerdictReasoning ?? "",
        recommendation: application.matchRecommendation,
        strengths: application.matchStrengths,
        weaknesses: application.matchWeaknesses,
        risks: application.matchRisks,
        analysis: null,
      });
      return;
    }

    const claimed = await claimRowById(CLAIM_MATCH_VERDICT_SQL, application.id);
    if (!claimed) return;

    try {
      const job = await jobRepo().findOne({
        where: { id: application.jobId },
        relations: { aiConfig: true },
      });
      if (!job) {
        await recordMatchVerdictFailure(application.id, new Error("Job not found"), {
          permanent: true,
        });
        return;
      }

      const aiConfig = job.aiConfig as AIConfig | null;
      // A disabled personality stage must never influence the verdict, even if
      // answers/mbtiType happen to exist (e.g. the stage was disabled after the
      // talent already completed it).
      const includePersonality = aiConfig ? aiConfig.personalityEvaluation : true;
      const includePersonalized = aiConfig ? aiConfig.personalizedAssessment : true;

      const [cvChunks, personalizedQuestionsAndAnswers, personalityQuestionsAndAnswers] =
        await Promise.all([
          talentEmbeddingRepo().find({ where: { userId: talent.id }, select: { cvText: true } }),
          buildQuestionAnswerPairs(application.jobId, talent.id, QuestionType.Personalized),
          includePersonality
            ? buildQuestionAnswerPairs(application.jobId, talent.id, QuestionType.Personality)
            : Promise.resolve([]),
        ]);
      const cvText = cvChunks.map((c) => c.cvText ?? "").join("\n\n");

      const response = await assessApplicationMatch({
        jobDescription: job.jobBrief,
        skills: job.skills ?? undefined,
        requirements: job.requirements ?? undefined,
        goals: job.goals ?? undefined,
        recruiterGuide: aiConfig?.recruiterGuide ?? undefined,
        cvSimilarityScore: application.cvSimilarityScore,
        personalizedScore: includePersonalized ? application.personalizedScore : null,
        prescreeningScore: isPrescreeningScoreValid(talent.prescreeningScoredAt)
          ? (talent.prescreeningScore ?? null)
          : null,
        mbtiType: includePersonality ? application.mbtiType : null,
        cvText: cvText || undefined,
        personalizedQuestionsAndAnswers:
          includePersonalized && personalizedQuestionsAndAnswers.length > 0
            ? personalizedQuestionsAndAnswers
            : undefined,
        personalityQuestionsAndAnswers:
          personalityQuestionsAndAnswers.length > 0 ? personalityQuestionsAndAnswers : undefined,
        talentLocation: {
          city: talent.locationCity ?? undefined,
          state: talent.locationState ?? undefined,
          country: talent.locationCountry ?? undefined,
        },
        workType: talent.workType ?? undefined,
        experience: talent.experience ?? undefined,
        talentName: [talent.firstName, talent.lastName].filter(Boolean).join(" ") || undefined,
        talentBio: talent.bio ?? undefined,
      });
      if (!response?.message.content) {
        throw new ValidationError("Error with LLM");
      }

      const parsed = JSON.parse(response.message.content) as Record<string, unknown>;

      // The LLM is instructed to return exactly "high"/"medium"/"low", but nothing
      // guarantees it does — an unvalidated write straight to this enum column was
      // the actual reason verdicts silently never appeared: any casing/wording
      // deviation ("High", etc.) failed the DB write, was swallowed by the catch
      // below, and left matchVerdict null forever with no visible error.
      const normalizedVerdict = String(parsed.verdict ?? "")
        .trim()
        .toLowerCase();
      const validVerdicts = Object.values(MatchVerdict) as string[];
      if (!validVerdicts.includes(normalizedVerdict)) {
        throw new ValidationError(`Unexpected verdict value from LLM: "${parsed.verdict}"`);
      }

      // Same validate-before-write discipline as the verdict above — a stray
      // casing/wording deviation here must not silently drop the whole update.
      const normalizedRecommendation = String(parsed.recommendation ?? "")
        .trim()
        .toLowerCase();
      const validRecommendations = Object.values(MatchRecommendation) as string[];
      const recommendation = validRecommendations.includes(normalizedRecommendation ?? "")
        ? (normalizedRecommendation as MatchRecommendation)
        : null;

      const analysis = parseMatchAnalysis(parsed, normalizedVerdict);

      await persistRecommendation(application.id, {
        verdict: normalizedVerdict as MatchVerdict,
        reasoning:
          typeof parsed.reasoning === "string" ? parsed.reasoning : analysis.hiringRationale,
        recommendation,
        strengths: Array.isArray(parsed.strengths) ? (parsed.strengths as string[]) : null,
        weaknesses: Array.isArray(parsed.weaknesses) ? (parsed.weaknesses as string[]) : null,
        risks: Array.isArray(parsed.risks) ? (parsed.risks as string[]) : null,
        analysis,
      });
    } catch (err) {
      logger.error(
        `Match verdict generation failed for application ${application.id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      await recordMatchVerdictFailure(application.id, err);
    }
  } catch (err) {
    logger.error(
      `Match verdict trigger failed for application ${application.id}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
};

export const triggerMatchVerdict = (
  talent: User,
  application: Application,
  options: TriggerMatchVerdictOptions = {}
): Promise<void> => {
  const task = executeTriggerMatchVerdict(talent, application, options);
  inFlightMatchVerdicts.add(task);
  return task.finally(() => {
    inFlightMatchVerdicts.delete(task);
  });
};

export const resetMatchVerdictRetry = async (applicationId: string): Promise<void> => {
  await applicationRepo().update(applicationId, {
    matchVerdictStatus: MatchVerdictStatus.Pending,
    matchVerdictAttempts: 0,
    matchVerdictNextRetryAt: null,
    matchVerdictLockedAt: null,
    matchVerdictLastError: null,
  });
};

export const reconcileDueMatchVerdicts = async (): Promise<{
  scanned: number;
  attempted: number;
}> => {
  const ids = await selectDueIds(DUE_MATCH_VERDICT_SQL, [MAX_DURABLE_ATTEMPTS, SWEEP_BATCH_SIZE]);
  let attempted = 0;
  for (const id of ids) {
    const application = await applicationRepo().findOne({
      where: { id },
      relations: { talent: true },
    });
    if (!application) continue;
    const talent =
      application.talent ??
      (await AppDataSource.getRepository(User).findOne({ where: { id: application.talentId } }));
    if (!talent) continue;
    attempted++;
    await triggerMatchVerdict(talent, application);
  }
  return { scanned: ids.length, attempted };
};

export const processNextStage = async (
  talent: User,
  application: Application,
  stage: ScreeningStage,
  aiConfig?: AIConfig | null
): Promise<Application> => {
  const stages = application.stages ?? {};
  const nextStage = stages[stage];

  if (!nextStage) {
    throw new ValidationError("Next stage not found");
  }

  application.currentStage = nextStage as Application["currentStage"];

  if (nextStage === ScreeningStage.Completed) {
    await rankApplication(talent, application, aiConfig);
    application.status = ApplicationStatus.AwaitingDecision;
    application.matchVerdictStatus = MatchVerdictStatus.Pending;
    application.matchVerdictAttempts = 0;
    application.matchVerdictNextRetryAt = null;
    application.matchVerdictLockedAt = null;
    application.matchVerdictLastError = null;
    void triggerMatchVerdict(talent, application);
  } else {
    application.status = ApplicationStatus.Pending;
  }

  if (nextStage === ScreeningStage.CvSimilarity && aiConfig) {
    const score = await computeCvSimilarityScore(application.jobId, talent.id);
    if (score !== null) {
      return runCvSimilarityGate(talent, application, aiConfig, score);
    }
  }

  return application;
};

// Scores the talent's best-matching CV chunk against the job. Null means one of
// the embeddings doesn't exist yet — never a score of zero distance.
export const computeCvSimilarityScore = async (
  jobId: string,
  talentId: string
): Promise<number | null> => {
  const rows: Array<{ distance: number | null }> = await AppDataSource.query(
    `
    SELECT MIN(te.cv_embedding::vector <=> j.job_embedding::vector) AS distance
    FROM talent_embeddings te
    JOIN jobs j ON j.id = $1
    WHERE te.user_id = $2
      AND te.cv_embedding IS NOT NULL
      AND j.job_embedding IS NOT NULL
    `,
    [jobId, talentId]
  );
  const distance = rows[0]?.distance;
  if (distance === null || distance === undefined) return null;
  return convertSimilarityToPercentage(Math.min(Math.max(Number(distance), 0), 1));
};

export const runCvSimilarityGate = async (
  talent: User,
  application: Application,
  aiConfig: AIConfig,
  score: number
): Promise<Application> => {
  application.cvSimilarityScore = score;
  application.cvSimilarityAttempts = (application.cvSimilarityAttempts ?? 0) + 1;

  const passed = score >= (aiConfig.minCvSimilarityScore ?? 0);
  if (passed || application.cvSimilarityAttempts >= CV_SIMILARITY_MAX_ATTEMPTS) {
    return processNextStage(talent, application, ScreeningStage.CvSimilarity, aiConfig);
  }

  application.status = ApplicationStatus.RetakeAssessment;
  return application;
};

// Runs once a talent's CV embedding is (re)generated: refreshes the match score
// on every open application, and puts any application waiting at the CV stage
// through the gate — this is also the retry path after a CV re-upload.
export const rescoreCvSimilarityForTalent = async (talentId: string): Promise<void> => {
  const talent = await userRepo().findOne({ where: { id: talentId } });
  if (!talent) return;

  const applications = await applicationRepo().find({
    where: { talentId, currentStage: Not(ScreeningStage.Completed) },
    relations: { job: { aiConfig: true } },
  });

  for (const application of applications) {
    const aiConfig = application.job?.aiConfig;
    if (!aiConfig?.cvSimilarity) continue;
    await rescoreCvSimilarity(talent, application, aiConfig);
  }
};

// Saves a fresh score on one application, gating it when it's waiting at the
// CV stage. Returns null (nothing saved) while an embedding is missing.
export const rescoreCvSimilarity = async (
  talent: User,
  application: Application,
  aiConfig: AIConfig
): Promise<Application | null> => {
  const score = await computeCvSimilarityScore(application.jobId, talent.id);
  if (score === null) return null;

  const awaitingGate =
    application.currentStage === ScreeningStage.CvSimilarity &&
    (application.status === ApplicationStatus.Pending ||
      application.status === ApplicationStatus.RetakeAssessment);

  if (awaitingGate) {
    return applicationRepo().save(await runCvSimilarityGate(talent, application, aiConfig, score));
  }
  application.cvSimilarityScore = score;
  return applicationRepo().save(application);
};

// Advances every one of the talent's applications currently parked at the (global,
// job-agnostic) Prescreening stage, gated per-application by that job's own
// minPrescreeningScore — never mutates the global PreScreening/User.prescreeningScore.
export const advanceApplicationsAfterPrescreening = async (
  talent: User,
  prescreeningScore: number
): Promise<void> => {
  const apps = await applicationRepo().find({
    where: { talentId: talent.id, currentStage: ScreeningStage.Prescreening },
  });

  for (const application of apps) {
    const job = await jobRepo().findOne({
      where: { id: application.jobId },
      relations: { aiConfig: true },
    });
    const minScore = (job?.aiConfig as AIConfig | undefined)?.minPrescreeningScore ?? 0;

    let updated: Application;
    if (prescreeningScore < minScore) {
      application.status = ApplicationStatus.RetakeAssessment;
      application.assessmentRetryDate = getAssessmentRetryDate();
      updated = application;
    } else {
      updated = await processNextStage(
        talent,
        application,
        ScreeningStage.Prescreening,
        job?.aiConfig ?? null
      );
    }
    await applicationRepo().save(updated);
  }
};
