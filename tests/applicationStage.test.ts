/**
 * applicationStage tests — item 1 (recruiter-manual shortlisting, not automatic)
 * and the AI match-verdict trigger that runs alongside it.
 */

import {
  processNextStage,
  triggerMatchVerdict,
  rankApplication,
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
} from "./helpers/fixtures.js";
import { Application } from "../src/entities/Application.js";
import { ApplicationStatus, ScreeningStage, MatchVerdict } from "../src/types/enums.js";
import { assessApplicationMatch } from "../src/utils/integrations/openai.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  __esModule: true,
  assessApplicationMatch: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        verdict: "high",
        reasoning: "Strong CV match and consistent scores across the pipeline.",
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

describe("triggerMatchVerdict — AI verdict is advisory and recruiter-facing only", () => {
  it("persists the verdict/reasoning returned by the LLM onto the application", async () => {
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
    expect(reloaded?.matchVerdictReasoning).toContain("Strong CV match");
  });

  it("does not throw when the job can't be found (defensive no-op)", async () => {
    const { user: talent } = await createTalent();
    const application = Object.assign(new Application(), {
      id: "00000000-0000-0000-0000-000000000000",
      jobId: "00000000-0000-0000-0000-000000000000",
      cvSimilarityScore: null,
      personalizedScore: null,
      mbtiType: null,
    });

    await expect(triggerMatchVerdict(talent, application)).resolves.toBeUndefined();
    expect(mockAssessApplicationMatch).not.toHaveBeenCalled();
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
  });
});
