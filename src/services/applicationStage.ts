import { Not, IsNull } from "typeorm";
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
  MatchRecommendation,
  QuestionType,
} from "../types/enums.js";
import { ValidationError } from "../utils/errors";
import { assessApplicationMatch } from "../utils/integrations/openai.js";
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
  }
): Promise<void> => {
  const existing = await aiRecommendationRepo().findOne({ where: { applicationId } });
  if (existing) {
    await aiRecommendationRepo().save({
      ...existing,
      ...payload,
    });
  } else {
    await aiRecommendationRepo().save(
      aiRecommendationRepo().create({
        applicationId,
        ...payload,
      })
    );
  }

  // Keep denormalized columns on applications in sync for existing API consumers.
  await applicationRepo().update(applicationId, {
    matchVerdict: payload.verdict,
    matchVerdictReasoning: payload.reasoning,
    matchRecommendation: payload.recommendation,
    matchStrengths: payload.strengths,
    matchWeaknesses: payload.weaknesses,
    matchRisks: payload.risks,
  });
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

export const rankApplication = async (talent: User, application: Application): Promise<void> => {
  const prescreeningScore = talent.prescreeningScore ?? undefined;
  const scores = [
    application.cvSimilarityScore,
    application.personalizedScore,
    prescreeningScore,
  ].filter((s): s is number => s !== null && s !== undefined);

  const averageScore =
    scores.length > 0 ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : 0;

  application.averageScore = averageScore;

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
      });
      return;
    }

    const job = await jobRepo().findOne({
      where: { id: application.jobId },
      relations: { aiConfig: true },
    });
    if (!job) return;

    const aiConfig = job.aiConfig as AIConfig | null;

    const [cvChunks, personalizedQuestionsAndAnswers, personalityQuestionsAndAnswers] =
      await Promise.all([
        talentEmbeddingRepo().find({ where: { userId: talent.id }, select: { cvText: true } }),
        buildQuestionAnswerPairs(application.jobId, talent.id, QuestionType.Personalized),
        buildQuestionAnswerPairs(application.jobId, talent.id, QuestionType.Personality),
      ]);
    const cvText = cvChunks.map((c) => c.cvText ?? "").join("\n\n");

    const response = await assessApplicationMatch({
      jobDescription: job.jobBrief,
      recruiterGuide: aiConfig?.recruiterGuide ?? undefined,
      cvSimilarityScore: application.cvSimilarityScore,
      personalizedScore: application.personalizedScore,
      prescreeningScore: talent.prescreeningScore ?? null,
      mbtiType: application.mbtiType,
      cvText: cvText || undefined,
      personalizedQuestionsAndAnswers:
        personalizedQuestionsAndAnswers.length > 0 ? personalizedQuestionsAndAnswers : undefined,
      personalityQuestionsAndAnswers:
        personalityQuestionsAndAnswers.length > 0 ? personalityQuestionsAndAnswers : undefined,
    });
    if (!response?.message.content) {
      throw new ValidationError("Error with LLM");
    }

    const parsed = JSON.parse(response.message.content) as {
      verdict: string;
      reasoning: string;
      strengths?: string[];
      weaknesses?: string[];
      risks?: string[];
      recommendation?: string;
    };

    // The LLM is instructed to return exactly "high"/"medium"/"low", but nothing
    // guarantees it does — an unvalidated write straight to this enum column was
    // the actual reason verdicts silently never appeared: any casing/wording
    // deviation ("High", etc.) failed the DB write, was swallowed by the catch
    // below, and left matchVerdict null forever with no visible error.
    const normalizedVerdict = parsed.verdict?.trim().toLowerCase();
    const validVerdicts = Object.values(MatchVerdict) as string[];
    if (!validVerdicts.includes(normalizedVerdict)) {
      throw new ValidationError(`Unexpected verdict value from LLM: "${parsed.verdict}"`);
    }

    // Same validate-before-write discipline as the verdict above — a stray
    // casing/wording deviation here must not silently drop the whole update.
    const normalizedRecommendation = parsed.recommendation?.trim().toLowerCase();
    const validRecommendations = Object.values(MatchRecommendation) as string[];
    const recommendation = validRecommendations.includes(normalizedRecommendation ?? "")
      ? (normalizedRecommendation as MatchRecommendation)
      : null;

    await persistRecommendation(application.id, {
      verdict: normalizedVerdict as MatchVerdict,
      reasoning: parsed.reasoning,
      recommendation,
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : null,
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : null,
      risks: Array.isArray(parsed.risks) ? parsed.risks : null,
    });
  } catch (err) {
    logger.error(
      `Match verdict generation failed for application ${application.id}: ${(err as Error).message}`
    );
  }
};

export const processNextStage = async (
  talent: User,
  application: Application,
  stage: ScreeningStage
): Promise<Application> => {
  const stages = application.stages ?? {};
  const nextStage = stages[stage];

  if (!nextStage) {
    throw new ValidationError("Next stage not found");
  }

  application.currentStage = nextStage as Application["currentStage"];

  if (nextStage === ScreeningStage.Completed) {
    await rankApplication(talent, application);
    application.status = ApplicationStatus.AwaitingDecision;
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
      updated = await processNextStage(talent, application, ScreeningStage.Prescreening);
    }
    await applicationRepo().save(updated);
  }
};
