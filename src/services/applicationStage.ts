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
import { ValidationError } from "../utils/errors";
import { assessApplicationMatch } from "../utils/integrations/openai.js";
import { parseMatchAnalysis, type MatchAnalysis } from "../utils/matchAnalysis.js";
import { isPrescreeningScoreValid } from "./prescreening.js";
import logger from "../utils/logger.js";

const applicationRepo = () => AppDataSource.getRepository(Application);

const aiRecommendationRepo = () => AppDataSource.getRepository(AiRecommendation);

const jobRepo = () => AppDataSource.getRepository(Job);

const answerRepo = () => AppDataSource.getRepository(Answer);

const questionRepo = () => AppDataSource.getRepository(Question);

const talentEmbeddingRepo = () => AppDataSource.getRepository(TalentEmbedding);

// Joins an Answer row's responses back to their question text so the LLM gets
// readable Q&A pairs instead of opaque question IDs.
const buildQuestionAnswerPairs = async (
  jobId: string,
  userId: string,
  questionType: QuestionType.Personalized | QuestionType.Personality
): Promise<Array<{ question: string; answer: string; dichotomy?: string }>> => {
  const answer = await answerRepo().findOne({ where: { userId, jobId, questionType } });
  if (!answer || answer.responses.length === 0) return [];

  const questions = await questionRepo().find({ where: { jobId, type: questionType } });
  const questionsById = new Map(questions.map((q) => [q.id, q]));

  return answer.responses.map((r) => {
    const question = questionsById.get(r.questionId);
    return {
      question: question?.question ?? "Unknown question",
      answer: r.answer,
      ...(question?.criteria ? { dichotomy: question.criteria } : {}),
    };
  });
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
  // Both writes must land together — a partial write here is exactly what lets
  // ai_recommendations and the denormalized Application columns drift apart.
  await AppDataSource.transaction(async (manager) => {
    const existing = await manager.findOne(AiRecommendation, { where: { applicationId } });
    if (existing) {
      await manager.save(AiRecommendation, { ...existing, ...payload });
    } else {
      await manager.save(
        AiRecommendation,
        manager.create(AiRecommendation, { applicationId, ...payload })
      );
    }

    // Keep denormalized columns on applications in sync for existing API consumers.
    await manager.update(Application, applicationId, {
      matchVerdict: payload.verdict,
      matchVerdictStatus: MatchVerdictStatus.Succeeded,
      matchVerdictReasoning: payload.reasoning,
      matchRecommendation: payload.recommendation,
      matchStrengths: payload.strengths,
      matchWeaknesses: payload.weaknesses,
      matchRisks: payload.risks,
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
  /** When true, call OpenAI even if a recommendation already exists (recruiter regenerate). */
  force?: boolean;
}

// Advisory only — never blocks the actual stage transition. Callers fire this
// without awaiting it so it doesn't delay the response; failures (including a
// missing/unparsable LLM response) are logged and swallowed rather than surfaced
// to the talent. Exported `async` (rather than void-returning) so tests can await
// it directly instead of racing the fire-and-forget call.
//
// Recommendations are persisted in `ai_recommendations` and generated once.
// Opening the AI Match panel / applicant table reads the stored row — it does
// not recompute. Only an explicit regenerate (force: true) calls OpenAI again.
export const triggerMatchVerdict = async (
  talent: User,
  application: Application,
  options: TriggerMatchVerdictOptions = {}
): Promise<void> => {
  try {
    const existingRecommendation = await aiRecommendationRepo().findOne({
      where: { applicationId: application.id },
    });

    if (existingRecommendation && !options.force) {
      // Already generated — sync application columns if they were cleared, then exit.
      if (!application.matchVerdict) {
        await applicationRepo().update(application.id, {
          matchVerdict: existingRecommendation.verdict,
          matchVerdictReasoning: existingRecommendation.reasoning,
          matchRecommendation: existingRecommendation.recommendation,
          matchStrengths: existingRecommendation.strengths,
          matchWeaknesses: existingRecommendation.weaknesses,
          matchRisks: existingRecommendation.risks,
        });
      }
      return;
    }

    // Legacy rows that have match columns but no ai_recommendations row yet —
    // promote without calling OpenAI again.
    if (!options.force && application.matchVerdict) {
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

    const job = await jobRepo().findOne({
      where: { id: application.jobId },
      relations: { aiConfig: true },
    });
    if (!job) {
      await applicationRepo().update(application.id, {
        matchVerdictStatus: MatchVerdictStatus.Failed,
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

    await applicationRepo().update(application.id, {
      matchVerdictStatus: MatchVerdictStatus.Pending,
    });

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
    const normalizedVerdict = String(parsed.verdict ?? "").trim().toLowerCase();
    const validVerdicts = Object.values(MatchVerdict) as string[];
    if (!validVerdicts.includes(normalizedVerdict)) {
      throw new ValidationError(`Unexpected verdict value from LLM: "${parsed.verdict}"`);
    }

    // Same validate-before-write discipline as the verdict above — a stray
    // casing/wording deviation here must not silently drop the whole update.
    const normalizedRecommendation = String(parsed.recommendation ?? "").trim().toLowerCase();
    const validRecommendations = Object.values(MatchRecommendation) as string[];
    const recommendation = validRecommendations.includes(normalizedRecommendation ?? "")
      ? (normalizedRecommendation as MatchRecommendation)
      : null;

    const analysis = parseMatchAnalysis(parsed, normalizedVerdict);

    await persistRecommendation(application.id, {
      verdict: normalizedVerdict as MatchVerdict,
      reasoning:
        typeof parsed.reasoning === "string"
          ? parsed.reasoning
          : analysis.hiringRationale,
      recommendation,
      strengths: Array.isArray(parsed.strengths) ? (parsed.strengths as string[]) : null,
      weaknesses: Array.isArray(parsed.weaknesses) ? (parsed.weaknesses as string[]) : null,
      risks: Array.isArray(parsed.risks) ? (parsed.risks as string[]) : null,
      analysis,
    });
  } catch (err) {
    logger.error(
      `Match verdict generation failed for application ${application.id}: ${(err as Error).message}`
    );
    await applicationRepo().update(application.id, {
      matchVerdictStatus: MatchVerdictStatus.Failed,
    });
  }
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
    void triggerMatchVerdict(talent, application);
  } else {
    application.status = ApplicationStatus.Pending;
  }

  return application;
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
