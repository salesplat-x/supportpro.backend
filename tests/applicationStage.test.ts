/**
 * applicationStage tests — item 1 (recruiter-manual shortlisting, not automatic)
 * and the AI match-verdict trigger that runs alongside it.
 */

import {
  processNextStage,
  triggerMatchVerdict,
  rankApplication,
  loadApplicationWithMatch,
  loadRecommendationsByApplicationIds,
  overlayVerdictFromRecommendation,
} from "../src/services/applicationStage.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createTalent,
  createRecruiter,
  createRole,
  createJob,
  createApplication,
  createQuestion,
  createAIConfig,
} from "./helpers/fixtures.js";
import { Application } from "../src/entities/Application.js";
import { AiRecommendation } from "../src/entities/AiRecommendation.js";
import { Answer } from "../src/entities/Answer.js";
import { TalentEmbedding } from "../src/entities/TalentEmbedding.js";
import {
  ApplicationStatus,
  ScreeningStage,
  MatchVerdict,
  MatchVerdictStatus,
  MatchRecommendation,
  QuestionType,
} from "../src/types/enums.js";
import { assessApplicationMatch } from "../src/utils/integrations/openai.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  __esModule: true,
  assessApplicationMatch: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        verdict: "high",
        reasoning: "Strong CV match and consistent scores across the pipeline.",
        strengths: ["Five years of relevant TypeScript experience per the CV."],
        weaknesses: ["No direct leadership experience mentioned."],
        risks: ["May need ramp-up time on the specific stack used here."],
        recommendation: "hire",
      }),
    },
  }),
}));

const mockAssessApplicationMatch = assessApplicationMatch as jest.MockedFunction<
  typeof assessApplicationMatch
>;

beforeAll(async () => {
  await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

describe("processNextStage — reaching Completed no longer auto-shortlists", () => {
  it("sets status to AwaitingDecision, not Shortlisted, when the chain reaches Completed", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Personality,
      stages: { personality: "completed" },
    });

    const updated = await processNextStage(talent, application, ScreeningStage.Personality);

    expect(updated.status).toBe(ApplicationStatus.AwaitingDecision);
    expect(updated.currentStage).toBe(ScreeningStage.Completed);
    expect(updated.status).not.toBe(ApplicationStatus.Shortlisted);
  });

  it("sets status to Pending for a non-terminal stage transition", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.CvSimilarity,
      stages: { cv_similarity: "personalized" },
    });

    const updated = await processNextStage(talent, application, ScreeningStage.CvSimilarity);

    expect(updated.status).toBe(ApplicationStatus.Pending);
    expect(updated.currentStage).toBe(ScreeningStage.Personalized);
  });

  it("still computes rank/averageScore on completion", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Personality,
      stages: { personality: "completed" },
      cvSimilarityScore: 80,
      personalizedScore: 70,
    });

    const updated = await processNextStage(talent, application, ScreeningStage.Personality);

    expect(updated.rank).not.toBeNull();
    expect(updated.averageScore).not.toBeNull();
  });

  it("throws when the next stage isn't found in the stages chain", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, { stages: {} });

    await expect(
      processNextStage(talent, application, ScreeningStage.Prescreening)
    ).rejects.toThrow("Next stage not found");
  });
});

describe("rankApplication — rank never exceeds the number of applicants who've finished", () => {
  it("ranks two completed applicants 1 and 2, not 3 of 2", async () => {
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const appA = await createApplication(talentA, job);
    const appB = await createApplication(talentB, job);
    const applicationRepo = testDataSource.getRepository(Application);

    await rankApplication(talentA, appA);
    await applicationRepo.save(appA);
    await rankApplication(talentB, appB);
    await applicationRepo.save(appB);

    expect(appA.rank).toBe(1);
    expect(appB.rank).toBe(2);
  });

  it("does not count applications still mid-pipeline (no rank yet) toward the total", async () => {
    const { user: finishedTalent } = await createTalent();
    const { user: pendingTalentA } = await createTalent();
    const { user: pendingTalentB } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const applicationRepo = testDataSource.getRepository(Application);

    // Two talents have applied but not finished — they exist as rows with no rank.
    await createApplication(pendingTalentA, job);
    await createApplication(pendingTalentB, job);
    const finishedApp = await createApplication(finishedTalent, job);

    await rankApplication(finishedTalent, finishedApp);
    await applicationRepo.save(finishedApp);

    expect(finishedApp.rank).toBe(1);
  });
});

describe("rankApplication — averageScore only reflects stages the job actually ran", () => {
  it("excludes a disabled stage's score from the average", async () => {
    const { user: talent } = await createTalent({
      prescreeningScore: 90,
      prescreeningScoredAt: new Date(),
    });
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      cvSimilarity: false,
      personalizedAssessment: true,
      prescreeningAssessment: true,
    });
    const application = await createApplication(talent, job, {
      cvSimilarityScore: 40, // stale/irrelevant — cvSimilarity is disabled for this job
      personalizedScore: 80,
    });

    await rankApplication(talent, application, aiConfig);

    // Average of personalizedScore (80) and prescreeningScore (90) only — the
    // disabled cvSimilarityScore (40) must not drag it down.
    expect(application.averageScore).toBe(85);
  });

  it("sets averageScore to null, not 0, when no enabled stage produced a score", async () => {
    const { user: talent } = await createTalent({ prescreeningScore: null });
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      cvSimilarity: false,
      personalizedAssessment: false,
      prescreeningAssessment: true,
    });
    const application = await createApplication(talent, job, {
      cvSimilarityScore: 40,
      personalizedScore: 80,
    });

    await rankApplication(talent, application, aiConfig);

    expect(application.averageScore).toBeNull();
  });

  it("falls back to including every present score when no aiConfig is passed (backward compatible)", async () => {
    const { user: talent } = await createTalent({
      prescreeningScore: 90,
      prescreeningScoredAt: new Date(),
    });
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      cvSimilarityScore: 40,
      personalizedScore: 80,
    });

    await rankApplication(talent, application);

    expect(application.averageScore).toBe(70);
  });

  it("excludes an expired prescreening score from the average", async () => {
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() - 91);
    const { user: talent } = await createTalent({
      prescreeningScore: 90,
      prescreeningScoredAt: expiredDate,
    });
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      cvSimilarity: false,
      personalizedAssessment: true,
      prescreeningAssessment: true,
    });
    const application = await createApplication(talent, job, {
      cvSimilarityScore: 40,
      personalizedScore: 80,
    });

    await rankApplication(talent, application, aiConfig);

    expect(application.averageScore).toBe(80);
  });

  it("treats a prescreening score with no scoredAt timestamp as expired", async () => {
    const { user: talent } = await createTalent({
      prescreeningScore: 90,
      prescreeningScoredAt: null,
    });
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      cvSimilarity: false,
      personalizedAssessment: true,
      prescreeningAssessment: true,
    });
    const application = await createApplication(talent, job, {
      cvSimilarityScore: 40,
      personalizedScore: 80,
    });

    await rankApplication(talent, application, aiConfig);

    expect(application.averageScore).toBe(80);
  });
});

describe("triggerMatchVerdict — AI verdict is advisory and recruiter-facing only", () => {
  it("persists the verdict/reasoning/evidence returned by the LLM onto the application", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
      cvSimilarityScore: 90,
    });

    await triggerMatchVerdict(talent, application);

    expect(mockAssessApplicationMatch).toHaveBeenCalledTimes(1);
    const reloaded = await testDataSource.getRepository(Application).findOne({
      where: { id: application.id },
    });
    expect(reloaded?.matchVerdict).toBe(MatchVerdict.High);
    expect(reloaded?.matchVerdictStatus).toBe(MatchVerdictStatus.Succeeded);
    expect(reloaded?.matchVerdictReasoning).toContain("Strong CV match");
    expect(reloaded?.matchRecommendation).toBe(MatchRecommendation.Hire);
    expect(reloaded?.matchStrengths).toEqual([
      "Five years of relevant TypeScript experience per the CV.",
    ]);
    expect(reloaded?.matchWeaknesses).toEqual(["No direct leadership experience mentioned."]);
    expect(reloaded?.matchRisks).toEqual([
      "May need ramp-up time on the specific stack used here.",
    ]);

    const stored = await testDataSource.getRepository(AiRecommendation).findOne({
      where: { applicationId: application.id },
    });
    expect(stored?.verdict).toBe(MatchVerdict.High);
    expect(stored?.reasoning).toContain("Strong CV match");
  });

  it("passes null prescreeningScore to the LLM when the stored score has expired", async () => {
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() - 91);
    const { user: talent } = await createTalent({
      prescreeningScore: 90,
      prescreeningScoredAt: expiredDate,
    });
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
      cvSimilarityScore: 90,
    });

    await triggerMatchVerdict(talent, application);

    expect(mockAssessApplicationMatch).toHaveBeenCalledWith(
      expect.objectContaining({ prescreeningScore: null })
    );
  });

  it("passes the prescreeningScore to the LLM when the stored score is still fresh", async () => {
    const { user: talent } = await createTalent({
      prescreeningScore: 90,
      prescreeningScoredAt: new Date(),
    });
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
      cvSimilarityScore: 90,
    });

    await triggerMatchVerdict(talent, application);

    expect(mockAssessApplicationMatch).toHaveBeenCalledWith(
      expect.objectContaining({ prescreeningScore: 90 })
    );
  });

  it("does not recompute when an ai_recommendations row already exists", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
      matchVerdict: MatchVerdict.Medium,
      matchVerdictReasoning: "Cached recommendation",
    });
    await testDataSource.getRepository(AiRecommendation).save(
      testDataSource.getRepository(AiRecommendation).create({
        applicationId: application.id,
        verdict: MatchVerdict.Medium,
        reasoning: "Cached recommendation",
        recommendation: MatchRecommendation.InterviewFurther,
        strengths: null,
        weaknesses: null,
        risks: null,
      })
    );

    mockAssessApplicationMatch.mockClear();
    await triggerMatchVerdict(talent, application);

    expect(mockAssessApplicationMatch).not.toHaveBeenCalled();
  });

  it("force regenerate calls OpenAI even when a recommendation already exists", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
      matchVerdict: MatchVerdict.Low,
      matchVerdictReasoning: "Old reasoning",
    });
    await testDataSource.getRepository(AiRecommendation).save(
      testDataSource.getRepository(AiRecommendation).create({
        applicationId: application.id,
        verdict: MatchVerdict.Low,
        reasoning: "Old reasoning",
        recommendation: MatchRecommendation.NoHire,
        strengths: null,
        weaknesses: null,
        risks: null,
      })
    );

    mockAssessApplicationMatch.mockClear();
    await triggerMatchVerdict(talent, application, { force: true });

    expect(mockAssessApplicationMatch).toHaveBeenCalledTimes(1);
    const stored = await testDataSource.getRepository(AiRecommendation).findOne({
      where: { applicationId: application.id },
    });
    expect(stored?.verdict).toBe(MatchVerdict.High);
  });

  it("gathers CV text and personalized/personality Q&A into the LLM context", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
    });

    await testDataSource.getRepository(TalentEmbedding).save(
      testDataSource.getRepository(TalentEmbedding).create({
        userId: talent.id,
        cvText: "Five years of backend engineering experience.",
        generatedAt: new Date(),
      })
    );

    const personalizedQuestion = await createQuestion(QuestionType.Personalized, {
      jobId: job.id,
    });
    await testDataSource.getRepository(Answer).save(
      testDataSource.getRepository(Answer).create({
        userId: talent.id,
        jobId: job.id,
        questionType: QuestionType.Personalized,
        responses: [{ questionId: personalizedQuestion.id, answer: "I shipped X at my last job." }],
      })
    );

    const personalityQuestion = await createQuestion(
      QuestionType.Personality,
      { jobId: job.id },
      { criteria: "EI" }
    );
    await testDataSource.getRepository(Answer).save(
      testDataSource.getRepository(Answer).create({
        userId: talent.id,
        jobId: job.id,
        questionType: QuestionType.Personality,
        responses: [
          {
            questionId: personalityQuestion.id,
            answer: "I recharge alone.",
            dichotomyPreference: "I",
          },
        ],
      })
    );

    await triggerMatchVerdict(talent, application);

    expect(mockAssessApplicationMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        cvText: "Five years of backend engineering experience.",
        personalizedQuestionsAndAnswers: [
          expect.objectContaining({
            question: personalizedQuestion.question,
            answer: "I shipped X at my last job.",
          }),
        ],
        personalityQuestionsAndAnswers: [
          expect.objectContaining({
            question: personalityQuestion.question,
            answer: "I recharge alone.",
            dichotomy: "EI",
          }),
        ],
      })
    );
  });

  it("rejects a recommendation value that isn't hire/interview_further/no_hire, without dropping the rest of the update", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
    });

    mockAssessApplicationMatch.mockResolvedValueOnce({
      message: {
        content: JSON.stringify({
          verdict: "high",
          reasoning: "Solid candidate overall.",
          recommendation: "definitely_hire",
        }),
      },
    } as unknown as Awaited<ReturnType<typeof assessApplicationMatch>>);

    await triggerMatchVerdict(talent, application);

    const reloaded = await testDataSource.getRepository(Application).findOne({
      where: { id: application.id },
    });
    expect(reloaded?.matchVerdict).toBe(MatchVerdict.High);
    expect(reloaded?.matchRecommendation).toBeNull();
  });

  it("does not throw when the job can't be found (defensive no-op), and marks the verdict failed so the row can't get stuck", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
    });
    // Point at a job id that doesn't exist to force the defensive branch.
    application.jobId = "00000000-0000-0000-0000-000000000000";

    await expect(triggerMatchVerdict(talent, application)).resolves.toBeUndefined();
    expect(mockAssessApplicationMatch).not.toHaveBeenCalled();

    const reloaded = await testDataSource.getRepository(Application).findOne({
      where: { id: application.id },
    });
    expect(reloaded?.matchVerdictStatus).toBe(MatchVerdictStatus.Failed);
  });

  it("normalizes a differently-cased verdict from the LLM instead of silently dropping it", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
    });

    mockAssessApplicationMatch.mockResolvedValueOnce({
      message: {
        content: JSON.stringify({ verdict: "High", reasoning: "Looks like a great fit." }),
      },
    } as unknown as Awaited<ReturnType<typeof assessApplicationMatch>>);

    await triggerMatchVerdict(talent, application);

    const reloaded = await testDataSource.getRepository(Application).findOne({
      where: { id: application.id },
    });
    expect(reloaded?.matchVerdict).toBe(MatchVerdict.High);
  });

  it("rejects a verdict value that isn't high/medium/low at all, rather than corrupting the row", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
    });

    mockAssessApplicationMatch.mockResolvedValueOnce({
      message: {
        content: JSON.stringify({ verdict: "excellent", reasoning: "Not a real enum value." }),
      },
    } as unknown as Awaited<ReturnType<typeof assessApplicationMatch>>);

    await expect(triggerMatchVerdict(talent, application)).resolves.toBeUndefined();

    const reloaded = await testDataSource.getRepository(Application).findOne({
      where: { id: application.id },
    });
    expect(reloaded?.matchVerdict).toBeNull();
  });

  it("swallows an LLM failure instead of throwing", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
    });

    mockAssessApplicationMatch.mockResolvedValueOnce({
      message: { content: null },
    } as unknown as Awaited<ReturnType<typeof assessApplicationMatch>>);

    await expect(triggerMatchVerdict(talent, application)).resolves.toBeUndefined();

    const reloaded = await testDataSource.getRepository(Application).findOne({
      where: { id: application.id },
    });
    expect(reloaded?.matchVerdict).toBeNull();
    expect(reloaded?.matchVerdictStatus).toBe(MatchVerdictStatus.Failed);
  });

  it("includes the job's skills, requirements, and goals in the LLM context", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role, {
      skills: ["TypeScript", "PostgreSQL"],
      requirements: "5+ years of backend experience",
      goals: ["Ship the payments migration"],
    });
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
    });

    await triggerMatchVerdict(talent, application);

    expect(mockAssessApplicationMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        skills: ["TypeScript", "PostgreSQL"],
        requirements: "5+ years of backend experience",
        goals: ["Ship the payments migration"],
      })
    );
  });

  it("excludes personality Q&A and mbtiType from the LLM context when personalityEvaluation is disabled", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const aiConfig = await createAIConfig(recruiter, { personalityEvaluation: false });
    const job = await createJob(recruiter, role, { aiConfigId: aiConfig.id });
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
      mbtiType: "INTJ",
    });

    const personalityQuestion = await createQuestion(
      QuestionType.Personality,
      { jobId: job.id },
      { criteria: "EI" }
    );
    await testDataSource.getRepository(Answer).save(
      testDataSource.getRepository(Answer).create({
        userId: talent.id,
        jobId: job.id,
        questionType: QuestionType.Personality,
        responses: [
          {
            questionId: personalityQuestion.id,
            answer: "I recharge alone.",
            dichotomyPreference: "I",
          },
        ],
      })
    );

    await triggerMatchVerdict(talent, application);

    expect(mockAssessApplicationMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        mbtiType: null,
        personalityQuestionsAndAnswers: undefined,
      })
    );
  });

  it("still includes personality Q&A and mbtiType when personalityEvaluation is enabled", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const aiConfig = await createAIConfig(recruiter, { personalityEvaluation: true });
    const job = await createJob(recruiter, role, { aiConfigId: aiConfig.id });
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
      mbtiType: "INTJ",
    });

    const personalityQuestion = await createQuestion(
      QuestionType.Personality,
      { jobId: job.id },
      { criteria: "EI" }
    );
    await testDataSource.getRepository(Answer).save(
      testDataSource.getRepository(Answer).create({
        userId: talent.id,
        jobId: job.id,
        questionType: QuestionType.Personality,
        responses: [
          {
            questionId: personalityQuestion.id,
            answer: "I recharge alone.",
            dichotomyPreference: "I",
          },
        ],
      })
    );

    await triggerMatchVerdict(talent, application);

    expect(mockAssessApplicationMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        mbtiType: "INTJ",
        personalityQuestionsAndAnswers: [
          expect.objectContaining({
            question: personalityQuestion.question,
            answer: "I recharge alone.",
          }),
        ],
      })
    );
  });
});

describe("verdict overlay helpers — ai_recommendations is the source of truth on read", () => {
  it("overlayVerdictFromRecommendation is a no-op when there's no recommendation", () => {
    const application = { matchVerdict: null } as unknown as Application;
    const result = overlayVerdictFromRecommendation(application, null);
    expect(result.matchVerdict).toBeNull();
  });

  it("loadApplicationWithMatch repairs a drifted row (recommendation exists, matchVerdict is null)", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: null,
    });
    await testDataSource.getRepository(AiRecommendation).save(
      testDataSource.getRepository(AiRecommendation).create({
        applicationId: application.id,
        verdict: MatchVerdict.High,
        reasoning: "Repaired from ai_recommendations.",
        recommendation: MatchRecommendation.Hire,
        strengths: null,
        weaknesses: null,
        risks: null,
      })
    );

    const loaded = await loadApplicationWithMatch(application.id);

    expect(loaded?.matchVerdict).toBe(MatchVerdict.High);
    expect(loaded?.matchVerdictStatus).toBe(MatchVerdictStatus.Succeeded);
    expect(loaded?.matchVerdictReasoning).toBe("Repaired from ai_recommendations.");
  });

  it("loadApplicationWithMatch returns null for a non-existent application", async () => {
    await expect(
      loadApplicationWithMatch("00000000-0000-0000-0000-000000000000")
    ).resolves.toBeNull();
  });

  it("loadRecommendationsByApplicationIds batches lookups into a map keyed by applicationId", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, { matchVerdict: null });
    await testDataSource.getRepository(AiRecommendation).save(
      testDataSource.getRepository(AiRecommendation).create({
        applicationId: application.id,
        verdict: MatchVerdict.Low,
        reasoning: "Batched lookup.",
        recommendation: null,
        strengths: null,
        weaknesses: null,
        risks: null,
      })
    );

    const map = await loadRecommendationsByApplicationIds([application.id]);

    expect(map.get(application.id)?.verdict).toBe(MatchVerdict.Low);
  });

  it("loadRecommendationsByApplicationIds returns an empty map for an empty input, without querying", async () => {
    const map = await loadRecommendationsByApplicationIds([]);
    expect(map.size).toBe(0);
  });

  it("persistRecommendation writes both tables atomically (transaction)", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
    });

    await triggerMatchVerdict(talent, application);

    const [applicationRow, recommendationRow] = await Promise.all([
      testDataSource.getRepository(Application).findOne({ where: { id: application.id } }),
      testDataSource
        .getRepository(AiRecommendation)
        .findOne({ where: { applicationId: application.id } }),
    ]);

    // Both rows exist and agree — this is what the transaction guarantees.
    expect(applicationRow?.matchVerdict).toBe(recommendationRow?.verdict);
    expect(applicationRow?.matchVerdictReasoning).toBe(recommendationRow?.reasoning);
  });
});
