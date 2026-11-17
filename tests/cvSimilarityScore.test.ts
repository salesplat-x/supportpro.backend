/**
 * CV similarity scoring — computed server-side at apply time, on entering the
 * CV stage, and whenever the talent's CV embedding is regenerated.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  computeCvSimilarityScore,
  processNextStage,
  rescoreCvSimilarityForTalent,
} from "../src/services/applicationStage.js";
import { apply } from "../src/services/job.js";
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
  createAIConfig,
} from "./helpers/fixtures.js";
import { Application } from "../src/entities/Application.js";
import { Job } from "../src/entities/Job.js";
import { TalentEmbedding } from "../src/entities/TalentEmbedding.js";
import { User } from "../src/entities/User.js";
import type { AIConfig } from "../src/entities/AIConfig.js";
import { ApplicationStatus, ScreeningStage } from "../src/types/enums.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  __esModule: true,
  createEmbedding: jest.fn(),
  assessApplicationMatch: jest.fn().mockResolvedValue({
    message: { content: JSON.stringify({ verdict: "high", reasoning: "Good fit." }) },
  }),
}));

/** A 512-dim vector pointing mostly along one axis, so distances are predictable. */
const vector = (lead: number): number[] => {
  const values = new Array<number>(512).fill(0.01);
  values[0] = lead;
  return values;
};

const asLiteral = (values: number[]) => `[${values.toString()}]`;

const ai = jest.requireMock("../src/utils/integrations/openai.js") as {
  createEmbedding: jest.Mock;
};

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

const embedCv = async (userId: string, ...leads: number[]) => {
  const repo = testDataSource.getRepository(TalentEmbedding);
  for (const lead of leads) {
    await repo.save(
      repo.create({
        userId,
        cvText: "CV chunk",
        cvEmbedding: asLiteral(vector(lead)),
        generatedAt: new Date(),
      })
    );
  }
};

const setup = async (): Promise<{
  talent: User;
  job: Job;
  aiConfig: AIConfig;
  recruiterToken: string;
}> => {
  const { user: recruiter, token: recruiterToken } = await createRecruiter();
  const { user: talent } = await createTalent({ cvFileName: "cv.pdf" });
  const role = await createRole();
  const aiConfig = await createAIConfig(recruiter);
  const job = await createJob(recruiter, role, { aiConfigId: aiConfig.id });
  await testDataSource.getRepository(Job).update(job.id, { jobEmbedding: asLiteral(vector(1)) });
  return { talent, job, aiConfig, recruiterToken };
};

const reload = (id: string) => testDataSource.getRepository(Application).findOneByOrFail({ id });

describe("computeCvSimilarityScore", () => {
  it("returns null when the talent has no CV embedding yet", async () => {
    const { talent, job } = await setup();
    expect(await computeCvSimilarityScore(job.id, talent.id)).toBeNull();
  });

  it("scores the best-matching CV chunk", async () => {
    const { talent, job } = await setup();
    await embedCv(talent.id, -1, 1);
    expect(await computeCvSimilarityScore(job.id, talent.id)).toBe(100);
  });

  it("clamps a cosine distance above 1 to 0% instead of throwing", async () => {
    const { talent, job } = await setup();
    await embedCv(talent.id, -1);
    expect(await computeCvSimilarityScore(job.id, talent.id)).toBe(0);
  });
});

describe("apply", () => {
  it("stores the CV match score on the new application", async () => {
    const { talent, job } = await setup();
    await embedCv(talent.id, 1);
    const application = await apply(talent, { jobId: job.id });
    expect((await reload(application.id)).cvSimilarityScore).toBe(100);
  });

  it("leaves the score empty while the CV embedding is pending", async () => {
    const { talent, job } = await setup();
    const application = await apply(talent, { jobId: job.id });
    expect((await reload(application.id)).cvSimilarityScore).toBeNull();
  });
});

describe("entering the CV stage", () => {
  const atPrescreening = (talent: User, job: Job, aiConfig: AIConfig) =>
    createApplication(talent, job, { stages: aiConfig.stages });

  it("advances past the CV stage without any client call when the score passes", async () => {
    const { talent, job, aiConfig } = await setup();
    await embedCv(talent.id, 1);
    const application = await processNextStage(
      talent,
      await atPrescreening(talent, job, aiConfig),
      ScreeningStage.Prescreening,
      aiConfig
    );
    expect(application.currentStage).toBe(ScreeningStage.Personalized);
    expect(application.cvSimilarityScore).toBe(100);
    expect(application.cvSimilarityAttempts).toBe(1);
  });

  it("asks for a retake when the score is below the minimum", async () => {
    const { talent, job, aiConfig } = await setup();
    await embedCv(talent.id, -1);
    const application = await processNextStage(
      talent,
      await atPrescreening(talent, job, aiConfig),
      ScreeningStage.Prescreening,
      aiConfig
    );
    expect(application.currentStage).toBe(ScreeningStage.CvSimilarity);
    expect(application.status).toBe(ApplicationStatus.RetakeAssessment);
    expect(application.cvSimilarityAttempts).toBe(1);
  });

  it("waits at the CV stage without using an attempt while the embedding is pending", async () => {
    const { talent, job, aiConfig } = await setup();
    const application = await processNextStage(
      talent,
      await atPrescreening(talent, job, aiConfig),
      ScreeningStage.Prescreening,
      aiConfig
    );
    expect(application.currentStage).toBe(ScreeningStage.CvSimilarity);
    expect(application.status).toBe(ApplicationStatus.Pending);
    expect(application.cvSimilarityAttempts).toBe(0);
  });
});

describe("rescoreCvSimilarityForTalent", () => {
  it("scores open applications and gates the ones waiting at the CV stage", async () => {
    const { talent, job, aiConfig } = await setup();
    const { user: otherRecruiter } = await createRecruiter();
    const otherJob = await createJob(otherRecruiter, await createRole(), {
      aiConfigId: (await createAIConfig(otherRecruiter)).id,
    });
    await testDataSource
      .getRepository(Job)
      .update(otherJob.id, { jobEmbedding: asLiteral(vector(1)) });

    const waiting = await createApplication(talent, job, {
      stages: aiConfig.stages,
      currentStage: ScreeningStage.CvSimilarity,
    });
    const earlier = await createApplication(talent, otherJob, { stages: aiConfig.stages });

    await embedCv(talent.id, 1);
    await rescoreCvSimilarityForTalent(talent.id);

    const gated = await reload(waiting.id);
    expect(gated.cvSimilarityScore).toBe(100);
    expect(gated.currentStage).toBe(ScreeningStage.Personalized);

    const scored = await reload(earlier.id);
    expect(scored.cvSimilarityScore).toBe(100);
    expect(scored.currentStage).toBe(ScreeningStage.Prescreening);
  });

  it("advances a retake once both attempts are used, even on a low score", async () => {
    const { talent, job, aiConfig } = await setup();
    const retake = await createApplication(talent, job, {
      stages: aiConfig.stages,
      currentStage: ScreeningStage.CvSimilarity,
      status: ApplicationStatus.RetakeAssessment,
      cvSimilarityAttempts: 1,
    });

    await embedCv(talent.id, -1);
    await rescoreCvSimilarityForTalent(talent.id);

    const updated = await reload(retake.id);
    expect(updated.cvSimilarityAttempts).toBe(2);
    expect(updated.currentStage).toBe(ScreeningStage.Personalized);
  });
});

describe("POST /v1/jobs/:jobId/applications/:applicationId/cv-score", () => {
  const retry = (token: string, jobId: string, applicationId: string) =>
    request(app)
      .post(`/v1/jobs/${jobId}/applications/${applicationId}/cv-score`)
      .set("Authorization", `Bearer ${token}`);

  it("saves the score for a past application once the CV embedding exists", async () => {
    const { talent, job, aiConfig, recruiterToken } = await setup();
    const application = await createApplication(talent, job, { stages: aiConfig.stages });
    await embedCv(talent.id, 1);

    const res = await retry(recruiterToken, job.id, application.id);

    expect(res.status).toBe(200);
    expect((await reload(application.id)).cvSimilarityScore).toBe(100);
  });

  it("re-embeds a CV that never processed, then saves the score", async () => {
    const { talent, job, aiConfig, recruiterToken } = await setup();
    await testDataSource
      .getRepository(User)
      .update(talent.id, { cvText: "Five years of TypeScript." });
    ai.createEmbedding.mockResolvedValue([{ embedding: vector(1) }]);
    const application = await createApplication(talent, job, { stages: aiConfig.stages });

    const res = await retry(recruiterToken, job.id, application.id);

    expect(res.status).toBe(200);
    expect((await reload(application.id)).cvSimilarityScore).toBe(100);
  });

  it("fails and leaves the score empty when the talent has no CV", async () => {
    const { talent, job, aiConfig, recruiterToken } = await setup();
    const application = await createApplication(talent, job, { stages: aiConfig.stages });

    const res = await retry(recruiterToken, job.id, application.id);

    expect(res.status).toBe(400);
    expect((await reload(application.id)).cvSimilarityScore).toBeNull();
  });

  it("rejects a recruiter who doesn't own the job", async () => {
    const { talent, job, aiConfig } = await setup();
    const { token: otherToken } = await createRecruiter();
    const application = await createApplication(talent, job, { stages: aiConfig.stages });
    await embedCv(talent.id, 1);

    const res = await retry(otherToken, job.id, application.id);

    expect(res.status).toBe(403);
    expect((await reload(application.id)).cvSimilarityScore).toBeNull();
  });
});
