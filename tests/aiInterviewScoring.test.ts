import fs from "fs";
import path from "path";
import request from "supertest";
import { createApp } from "../src/app.js";
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
  createOrganization,
} from "./helpers/fixtures.js";
import { User } from "../src/entities/User.js";
import { Application } from "../src/entities/Application.js";
import { AiInterview } from "../src/entities/AiInterview.js";
import { AiInterviewQuestion } from "../src/entities/AiInterviewQuestion.js";
import { ScreeningStage } from "../src/types/enums.js";
import * as OpenAI from "../src/utils/integrations/openai.js";
import { MAX_DURABLE_ATTEMPTS } from "../src/utils/durableJobs.js";
import { ValidationError } from "../src/utils/errors";
import { reconcileDueInterviewTranscripts } from "../src/services/aiInterviewTranscript.js";
import {
  parseInterviewAssessment,
  reconcileDueInterviewScoring,
} from "../src/services/aiInterviewScoring.js";

const bucket = new Map<string, { buffer: Buffer; contentType: string }>();
jest.mock("../src/services/aiInterviewTranscriptQueue.js", () => ({
  ...jest.requireActual("../src/services/aiInterviewTranscriptQueue.js"),
  queueTranscript: jest.fn(),
}));

jest.mock("../src/utils/integrations/spaces.js", () => {
  const actual = jest.requireActual("../src/utils/integrations/spaces.js");
  return {
    ...actual,
    isSpacesConfigured: jest.fn(() => true),
    uploadPrivateToSpaces: jest.fn(async (buffer: Buffer, key: string, contentType: string) => {
      bucket.set(key, { buffer, contentType });
    }),
    getFromSpaces: jest.fn(async (key: string) => {
      const item = bucket.get(key);
      if (!item) throw new Error(`no object ${key}`);
      return item.buffer;
    }),
    deleteSpacesObjectQuietly: jest.fn(async (key: string | null) => {
      if (key) bucket.delete(key);
    }),
  };
});

jest.mock("../src/utils/audioDuration.js", () => {
  const actual = jest.requireActual("../src/utils/audioDuration.js");
  return {
    ...actual,
    probeAudioDurationSeconds: jest.fn(async () => 3),
  };
});

jest.mock("../src/utils/integrations/openai.js", () => ({
  ...jest.requireActual("../src/utils/integrations/openai.js"),
  transcribeAudio: jest.fn(),
  generateAiInterviewFollowUp: jest.fn(),
  scoreAiInterviewAnswers: jest.fn(),
}));

const mockTranscribe = OpenAI.transcribeAudio as jest.Mock;
const mockFollowUp = OpenAI.generateAiInterviewFollowUp as jest.Mock;
const mockScore = OpenAI.scoreAiInterviewAnswers as jest.Mock;

const SHORT_WEBM = () =>
  fs.readFileSync(path.join(__dirname, "fixtures", "voice-3s-no-duration.webm"));
const ANSWER = "I led the onboarding team for two years and cut the backlog by half.";

const aiReply = (content: unknown) => ({
  message: { content: typeof content === "string" ? content : JSON.stringify(content) },
});

const GOOD_ASSESSMENT = {
  clearSpeaking: { score: 4, reason: "Answers come across in clear, well-paced sentences." },
  fitForRole: {
    score: 3,
    reason: "Relevant support experience, with little on the ticketing tools this role uses.",
  },
  confidence: { score: 4, reason: "Speaks plainly about past results without hedging." },
  summary: "Clear, organised answers with relevant experience. Ask about tooling next time.",
  flags: [{ text: "Little detail on the ticketing tools this role uses.", question: 2 }],
};

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  mockTranscribe.mockReset();
  mockTranscribe.mockResolvedValue(ANSWER);
  mockFollowUp.mockReset();
  mockFollowUp.mockResolvedValue(aiReply({ followUp: null }));
  mockScore.mockReset();
  mockScore.mockResolvedValue(aiReply(GOOD_ASSESSMENT));
});

afterEach(async () => {
  await clearAllTables();
  bucket.clear();
  jest.clearAllMocks();
});

async function setup() {
  const { user: poster } = await createRecruiter();
  const organization = await createOrganization(poster);
  const job = await createJob(poster, await createRole(), { organizationId: organization.id });
  const { user: teammate, token: teammateToken } = await createRecruiter();
  await testDataSource
    .getRepository(User)
    .update(teammate.id, { activeOrganizationId: organization.id });
  const { user: talent, token: talentToken } = await createTalent();
  const application = await createApplication(talent, job, {
    stages: { ai_interview: "completed" },
    currentStage: ScreeningStage.AiInterview,
  });
  const interviews = testDataSource.getRepository(AiInterview);
  const interview = await interviews.save({
    applicationId: application.id,
    jobId: job.id,
    talentId: talent.id,
    mode: "audio_video",
    status: "invited",
    invitedAt: new Date(),
  });
  const questionRepo = testDataSource.getRepository(AiInterviewQuestion);
  const questions = await questionRepo.save(
    [1, 2, 3, 4, 5].map((position) => ({
      interviewId: interview.id,
      position,
      question: `Question ${position}?`,
    }))
  );
  const upload = (token: string, questionId: string) =>
    request(app)
      .put(`/v1/interviews/${interview.id}/questions/${questionId}/recording`)
      .set("Authorization", `Bearer ${token}`)
      .attach("recording", SHORT_WEBM(), { filename: "answer.webm", contentType: "audio/webm" });
  const uploadAll = async (token: string) => {
    for (const question of questions) await upload(token, question.id);
  };
  const reloadInterview = () => interviews.findOneByOrFail({ id: interview.id });
  const reloadQuestion = (id: string) => questionRepo.findOneByOrFail({ id });
  const reloadApplication = () =>
    testDataSource.getRepository(Application).findOneByOrFail({ id: application.id });
  const assessment = (token: string) =>
    request(app)
      .get(`/v1/interviews/${interview.id}/assessment`)
      .set("Authorization", `Bearer ${token}`);
  const loadAsCandidate = (token: string) =>
    request(app).get(`/v1/interviews/${interview.id}`).set("Authorization", `Bearer ${token}`);
  const sweep = async () => {
    await reconcileDueInterviewTranscripts();
    await reconcileDueInterviewScoring();
  };
  return {
    interview,
    questions,
    talentToken,
    teammateToken,
    upload,
    uploadAll,
    reloadInterview,
    reloadQuestion,
    reloadApplication,
    assessment,
    loadAsCandidate,
    sweep,
    application,
  };
}

describe("when scoring starts", () => {
  it("waits while answers are still missing", async () => {
    const { talentToken, questions, upload, sweep, reloadInterview } = await setup();
    await upload(talentToken, questions[0]!.id);
    await upload(talentToken, questions[1]!.id);

    await sweep();

    expect(mockScore).not.toHaveBeenCalled();
    expect((await reloadInterview()).scoringStatus).toBeNull();
  });

  it("waits while an answer's transcript is still being made", async () => {
    mockTranscribe.mockRejectedValueOnce(new Error("socket hang up"));
    const { talentToken, uploadAll, sweep, reloadInterview } = await setup();
    await uploadAll(talentToken);

    await sweep();

    expect(mockScore).not.toHaveBeenCalled();
    expect((await reloadInterview()).scoringStatus).toBeNull();
  });

  it("scores once every answer is in and transcribed, and never again", async () => {
    const { talentToken, uploadAll, sweep, reloadInterview } = await setup();
    await uploadAll(talentToken);

    await sweep();
    await sweep();

    expect(mockScore).toHaveBeenCalledTimes(1);
    expect(mockScore).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: expect.arrayContaining([
          expect.objectContaining({ position: 1, question: "Question 1?", transcript: ANSWER }),
        ]),
      })
    );
    const interview = await reloadInterview();
    expect(interview.scoringStatus).toBe("completed");
    expect(interview.scores).toEqual({
      clearSpeaking: GOOD_ASSESSMENT.clearSpeaking,
      fitForRole: GOOD_ASSESSMENT.fitForRole,
      confidence: GOOD_ASSESSMENT.confidence,
    });
    expect(interview.summary).toBe(GOOD_ASSESSMENT.summary);
    expect(interview.flags).toEqual(GOOD_ASSESSMENT.flags);
    expect(interview.scoredAt).toBeInstanceOf(Date);
  });

  it("leaves out an answer whose transcript failed for good", async () => {
    mockTranscribe.mockRejectedValueOnce(new ValidationError("This recording is too long"));
    const { talentToken, uploadAll, sweep, reloadInterview, questions } = await setup();
    await uploadAll(talentToken);

    await sweep();

    expect(mockScore).toHaveBeenCalledTimes(1);
    const [input] = mockScore.mock.calls[0] as [{ answers: Array<{ transcript: string }> }];
    expect(input.answers).toHaveLength(4);
    expect(input.answers.every((answer) => answer.transcript === ANSWER)).toBe(true);
    expect((await reloadInterview()).scoringStatus).toBe("completed");
    expect(questions).toHaveLength(5);
  });
});

describe("saving the assessment", () => {
  it("a bad reply is not saved, and is tried again later", async () => {
    mockScore.mockResolvedValueOnce(
      aiReply({ ...GOOD_ASSESSMENT, clearSpeaking: { score: 9, reason: "Very clear." } })
    );
    const { talentToken, uploadAll, sweep, reloadInterview } = await setup();
    await uploadAll(talentToken);

    await sweep();

    const failed = await reloadInterview();
    expect(failed.scoringStatus).toBe("pending");
    expect(failed.scoringAttempts).toBe(1);
    expect(failed.scores).toBeNull();
    expect(failed.scoringLastError).toEqual(expect.any(String));
    expect(failed.scoringNextRetryAt!.getTime()).toBeGreaterThan(Date.now());

    await testDataSource
      .getRepository(AiInterview)
      .update(failed.id, { scoringNextRetryAt: new Date(0) });
    await sweep();

    const saved = await reloadInterview();
    expect(saved.scoringStatus).toBe("completed");
    expect(saved.summary).toBe(GOOD_ASSESSMENT.summary);
  });

  it("a refused second recording leaves the saved assessment alone", async () => {
    const { talentToken, uploadAll, upload, sweep, reloadInterview, questions } = await setup();
    await uploadAll(talentToken);
    await sweep();
    expect((await reloadInterview()).scoringStatus).toBe("completed");

    await upload(talentToken, questions[0]!.id);

    const kept = await reloadInterview();
    expect(kept.scoringStatus).toBe("completed");
    expect(kept.summary).toBe(GOOD_ASSESSMENT.summary);
    expect(mockScore).toHaveBeenCalledTimes(1);
  });

  it("a provider failure is retried later with the reason kept", async () => {
    mockScore.mockRejectedValueOnce(new Error("socket hang up"));
    const { talentToken, uploadAll, sweep, reloadInterview } = await setup();
    await uploadAll(talentToken);

    await sweep();

    const interview = await reloadInterview();
    expect(interview.scoringStatus).toBe("pending");
    expect(interview.scoringAttempts).toBe(1);
    expect(interview.scoringLastError).toBe("socket hang up");
  });

  it("gives up after the last attempt and marks the scoring failed", async () => {
    mockScore.mockRejectedValue(new Error("socket hang up"));
    const { talentToken, uploadAll, sweep, reloadInterview } = await setup();
    await uploadAll(talentToken);
    for (let attempt = 0; attempt < MAX_DURABLE_ATTEMPTS; attempt++) {
      await sweep();
      await testDataSource
        .getRepository(AiInterview)
        .update((await reloadInterview()).id, { scoringNextRetryAt: new Date(0) });
    }

    await sweep();

    const interview = await reloadInterview();
    expect(interview.scoringStatus).toBe("failed");
    expect(interview.scoringAttempts).toBe(MAX_DURABLE_ATTEMPTS);
    expect(mockScore).toHaveBeenCalledTimes(MAX_DURABLE_ATTEMPTS);
  });
});

describe("the assessment is advice only", () => {
  it("scoring changes no application or interview status", async () => {
    const { talentToken, uploadAll, sweep, reloadInterview, reloadApplication, application } =
      await setup();
    const before = await reloadApplication();
    await uploadAll(talentToken);

    await sweep();

    const after = await reloadApplication();
    expect(after.status).toBe(before.status);
    expect(after.currentStage).toBe(before.currentStage);
    expect(after.id).toBe(application.id);
    expect((await reloadInterview()).status).toBe("invited");
  });

  it("the candidate never sees the scores, the summary or the flags", async () => {
    const { talentToken, uploadAll, sweep, loadAsCandidate, assessment } = await setup();
    await uploadAll(talentToken);
    await sweep();

    const page = await loadAsCandidate(talentToken);
    expect(page.status).toBe(200);
    const text = JSON.stringify(page.body);
    expect(text).not.toContain("clearSpeaking");
    expect(text).not.toContain(GOOD_ASSESSMENT.summary);
    expect(text).not.toContain("flags");

    expect((await assessment(talentToken)).status).toBe(403);
  });

  it("the posting company reads the assessment; strangers and other candidates are refused", async () => {
    const { talentToken, teammateToken, uploadAll, sweep, assessment } = await setup();
    await uploadAll(talentToken);
    await sweep();
    const { token: strangerToken } = await createRecruiter();
    const { token: otherCandidateToken } = await createTalent();

    const res = await assessment(teammateToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: "completed",
      summary: GOOD_ASSESSMENT.summary,
      flags: GOOD_ASSESSMENT.flags,
      scores: {
        clearSpeaking: GOOD_ASSESSMENT.clearSpeaking,
        fitForRole: GOOD_ASSESSMENT.fitForRole,
        confidence: GOOD_ASSESSMENT.confidence,
      },
    });
    expect((await assessment(strangerToken)).status).toBe(403);
    expect((await assessment(otherCandidateToken)).status).toBe(403);
  });
});

describe("parsing the assessment reply", () => {
  it("reads a complete assessment", () => {
    const parsed = parseInterviewAssessment(JSON.stringify(GOOD_ASSESSMENT));
    expect(parsed.scores).toEqual({
      clearSpeaking: GOOD_ASSESSMENT.clearSpeaking,
      fitForRole: GOOD_ASSESSMENT.fitForRole,
      confidence: GOOD_ASSESSMENT.confidence,
    });
    expect(parsed.summary).toBe(GOOD_ASSESSMENT.summary);
    expect(parsed.flags).toEqual(GOOD_ASSESSMENT.flags);
  });

  it("reads plain-text flags as covering the whole interview", () => {
    const parsed = parseInterviewAssessment(
      JSON.stringify({ ...GOOD_ASSESSMENT, flags: ["Check the budget figure."] })
    );
    expect(parsed.flags).toEqual([{ text: "Check the budget figure.", question: null }]);
  });

  it("drops a question position that is not a whole number", () => {
    const parsed = parseInterviewAssessment(
      JSON.stringify({ ...GOOD_ASSESSMENT, flags: [{ text: "Vague answer.", question: "two" }] })
    );
    expect(parsed.flags).toEqual([{ text: "Vague answer.", question: null }]);
  });

  it.each([
    ["a score above 5", { ...GOOD_ASSESSMENT, confidence: { score: 6, reason: "Strong." } }],
    ["a score of 0", { ...GOOD_ASSESSMENT, fitForRole: { score: 0, reason: "None." } }],
    ["a fractional score", { ...GOOD_ASSESSMENT, clearSpeaking: { score: 3.5, reason: "Ok." } }],
    ["a missing reason", { ...GOOD_ASSESSMENT, clearSpeaking: { score: 4, reason: "" } }],
    ["flags that are not a list", { ...GOOD_ASSESSMENT, flags: "one flag" }],
    ["a flag with no text", { ...GOOD_ASSESSMENT, flags: [{ question: 1 }] }],
    ["a missing summary", { ...GOOD_ASSESSMENT, summary: "  " }],
    ["a reply that is not JSON", "not json"],
  ])("refuses %s", (_label, reply) => {
    const content = typeof reply === "string" ? reply : JSON.stringify(reply);
    expect(() => parseInterviewAssessment(content)).toThrow(ValidationError);
  });
});
