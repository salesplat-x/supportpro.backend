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
import { AiInterview } from "../src/entities/AiInterview.js";
import { AiInterviewQuestion } from "../src/entities/AiInterviewQuestion.js";
import { ScreeningStage } from "../src/types/enums.js";
import * as OpenAI from "../src/utils/integrations/openai.js";
import { MAX_DURABLE_ATTEMPTS } from "../src/utils/durableJobs.js";
import {
  reconcileDueInterviewTranscripts,
  transcriptExtensionFor,
} from "../src/services/aiInterviewTranscript.js";

const bucket = new Map<string, { buffer: Buffer; contentType: string }>();
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
    probeAudioDurationSeconds: jest.fn(async (buffer: Buffer) => {
      if (buffer.toString("utf8", 0, 4) === "fake") {
        throw new actual.AudioUnreadableError();
      }
      return buffer.length > 20_000 ? 130 : 3;
    }),
  };
});

jest.mock("../src/utils/integrations/openai.js", () => ({
  ...jest.requireActual("../src/utils/integrations/openai.js"),
  transcribeAudio: jest.fn(),
}));

const mockTranscribe = OpenAI.transcribeAudio as jest.Mock;

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", name));
const SHORT_WEBM = () => fixture("voice-3s-no-duration.webm");
const LONG_OGG = () => fixture("voice-130s.ogg");

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
  bucket.clear();
  jest.clearAllMocks();
});

async function setup() {
  const { user: poster, token: posterToken } = await createRecruiter();
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
  const interview = await testDataSource.getRepository(AiInterview).save({
    applicationId: application.id,
    jobId: job.id,
    talentId: talent.id,
    mode: "audio_video",
    status: "invited",
    invitedAt: new Date(),
  });
  const questions = await testDataSource.getRepository(AiInterviewQuestion).save(
    [1, 2, 3, 4, 5].map((position) => ({
      interviewId: interview.id,
      position,
      question: `Question ${position}?`,
    }))
  );
  const questionRepo = testDataSource.getRepository(AiInterviewQuestion);
  const url = (questionId = questions[0]!.id) =>
    `/v1/interviews/${interview.id}/questions/${questionId}/recording`;
  const upload = (token: string, body: Buffer, contentType = "audio/webm") =>
    request(app)
      .put(url())
      .set("Authorization", `Bearer ${token}`)
      .attach("recording", body, { filename: "answer.webm", contentType });
  const reload = (id = questions[0]!.id) => questionRepo.findOneByOrFail({ id });
  const transcripts = (token: string) =>
    request(app)
      .get(`/v1/interviews/${interview.id}/transcripts`)
      .set("Authorization", `Bearer ${token}`);
  return {
    poster,
    posterToken,
    teammateToken,
    talent,
    talentToken,
    interview,
    questions,
    questionRepo,
    upload,
    reload,
    transcripts,
  };
}

describe("queueing and saving a transcript", () => {
  it("queues the transcript when a recording is uploaded, and the upload still succeeds", async () => {
    const { talentToken, upload, reload } = await setup();
    const res = await upload(talentToken, SHORT_WEBM());
    expect(res.status).toBe(200);
    expect(mockTranscribe).not.toHaveBeenCalled();

    const question = await reload();
    expect(question.transcriptStatus).toBe("pending");
    expect(question.transcript).toBeNull();
    expect(question.transcriptAttempts).toBe(0);
  });

  it("the background job saves the transcript on the answer", async () => {
    mockTranscribe.mockResolvedValueOnce("I led the onboarding team for two years.");
    const { talentToken, upload, reload } = await setup();
    await upload(talentToken, SHORT_WEBM());

    await reconcileDueInterviewTranscripts();

    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    const [buffer, filename] = mockTranscribe.mock.calls[0];
    expect(Buffer.compare(buffer as Buffer, SHORT_WEBM())).toBe(0);
    expect(filename).toBe("voice.webm");

    const question = await reload();
    expect(question.transcript).toBe("I led the onboarding team for two years.");
    expect(question.transcriptStatus).toBe("completed");
    expect(question.transcribedAt).toBeInstanceOf(Date);
    expect(question.transcriptLockedAt).toBeNull();
    expect(question.transcriptLastError).toBeNull();
  });

  it("a failed transcription is retried later and the recording is kept", async () => {
    mockTranscribe.mockRejectedValueOnce(new Error("socket hang up"));
    const { talentToken, upload, reload, questionRepo, questions } = await setup();
    await upload(talentToken, SHORT_WEBM());

    await reconcileDueInterviewTranscripts();

    const failed = await reload();
    expect(failed.transcriptStatus).toBe("pending");
    expect(failed.transcriptAttempts).toBe(1);
    expect(failed.transcriptLastError).toBe("socket hang up");
    expect(failed.transcriptNextRetryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(failed.recordingKey).not.toBeNull();

    await questionRepo.update(questions[0]!.id, { transcriptNextRetryAt: new Date(0) });
    mockTranscribe.mockResolvedValueOnce("second try");
    await reconcileDueInterviewTranscripts();

    const retried = await reload();
    expect(retried.transcript).toBe("second try");
    expect(retried.transcriptStatus).toBe("completed");
  });

  it("gives up after the last attempt and marks the transcript failed", async () => {
    mockTranscribe.mockRejectedValueOnce(new Error("provider unavailable"));
    const { talentToken, upload, reload, questionRepo, questions } = await setup();
    await upload(talentToken, SHORT_WEBM());
    await questionRepo.update(questions[0]!.id, { transcriptAttempts: MAX_DURABLE_ATTEMPTS - 1 });

    await reconcileDueInterviewTranscripts();

    const question = await reload();
    expect(question.transcriptStatus).toBe("failed");
    expect(question.transcriptAttempts).toBe(MAX_DURABLE_ATTEMPTS);
    expect(question.transcriptNextRetryAt).toBeNull();
    expect(question.transcript).toBeNull();
  });

  it("a recording longer than the voice limit is failed without a paid call", async () => {
    const { talentToken, upload, reload } = await setup();
    await upload(talentToken, LONG_OGG(), "audio/ogg");

    await reconcileDueInterviewTranscripts();

    expect(mockTranscribe).not.toHaveBeenCalled();
    const question = await reload();
    expect(question.transcriptStatus).toBe("failed");
    expect(question.transcriptLastError).toMatch(/too long/);
  });

  it("audio that cannot be read is failed without a paid call", async () => {
    const { talentToken, upload, reload } = await setup();
    await upload(talentToken, Buffer.from("fake-audio"));

    await reconcileDueInterviewTranscripts();

    expect(mockTranscribe).not.toHaveBeenCalled();
    expect((await reload()).transcriptStatus).toBe("failed");
  });

  it("a job another worker holds is skipped until its lock is stale", async () => {
    mockTranscribe.mockResolvedValue("held then taken");
    const { talentToken, upload, reload, questionRepo, questions } = await setup();
    await upload(talentToken, SHORT_WEBM());
    await questionRepo.update(questions[0]!.id, { transcriptLockedAt: new Date() });

    await reconcileDueInterviewTranscripts();
    expect(mockTranscribe).not.toHaveBeenCalled();

    await questionRepo.update(questions[0]!.id, {
      transcriptLockedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    await reconcileDueInterviewTranscripts();
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect((await reload()).transcript).toBe("held then taken");
  });

  it("replacing a recording starts its transcript again", async () => {
    mockTranscribe.mockResolvedValueOnce("first answer");
    const { talentToken, upload, reload } = await setup();
    await upload(talentToken, SHORT_WEBM());
    await reconcileDueInterviewTranscripts();
    expect((await reload()).transcriptStatus).toBe("completed");

    await upload(talentToken, SHORT_WEBM());
    const question = await reload();
    expect(question.transcriptStatus).toBe("pending");
    expect(question.transcript).toBeNull();
    expect(question.transcriptAttempts).toBe(0);
    expect(question.transcribedAt).toBeNull();
  });

  it("a transcript for a recording replaced mid-job is not written", async () => {
    const { talentToken, upload, reload, questionRepo, questions } = await setup();
    await upload(talentToken, SHORT_WEBM());
    mockTranscribe.mockImplementationOnce(async () => {
      await questionRepo.update(questions[0]!.id, { recordingKey: "interview-recordings/newer" });
      return "words from the old recording";
    });

    await reconcileDueInterviewTranscripts();

    const question = await reload();
    expect(question.transcript).toBeNull();
    expect(question.transcriptStatus).toBe("pending");
  });
});

describe("the transcript format", () => {
  it("maps the recording types the transcription service takes, and nothing else", () => {
    expect(transcriptExtensionFor("audio/webm")).toBe("webm");
    expect(transcriptExtensionFor("video/webm")).toBe("webm");
    expect(transcriptExtensionFor("video/mp4")).toBe("mp4");
    expect(transcriptExtensionFor("audio/mpeg")).toBe("mp3");
    expect(transcriptExtensionFor("audio/wav")).toBe("wav");
    expect(transcriptExtensionFor("audio/ogg")).toBe("ogg");
    expect(transcriptExtensionFor("application/pdf")).toBeNull();
  });
});

describe("reading transcripts as the company", () => {
  it("the posting company reads each answer's transcript, never the storage key", async () => {
    mockTranscribe.mockResolvedValueOnce("My answer text.");
    const { talentToken, upload, transcripts, posterToken, interview, questions } = await setup();
    await upload(talentToken, SHORT_WEBM());
    await reconcileDueInterviewTranscripts();

    const res = await transcripts(posterToken);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.interviewId).toBe(interview.id);
    expect(res.body.data.questions).toHaveLength(5);
    const first = res.body.data.questions.find(
      (q: { questionId: string }) => q.questionId === questions[0]!.id
    );
    expect(first).toMatchObject({
      position: 1,
      question: "Question 1?",
      recorded: true,
      transcriptStatus: "completed",
      transcript: "My answer text.",
    });
    expect(first.transcribedAt).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("interview-recordings/");
  });

  it("a teammate in the posting company reads them too", async () => {
    const { transcripts, teammateToken } = await setup();
    expect((await transcripts(teammateToken)).status).toBe(200);
  });

  it("the candidate is refused", async () => {
    const { transcripts, talentToken } = await setup();
    expect((await transcripts(talentToken)).status).toBe(403);
  });

  it("a recruiter outside the company is refused", async () => {
    const { transcripts } = await setup();
    const { token: strangerToken } = await createRecruiter();
    expect((await transcripts(strangerToken)).status).toBe(403);
  });

  it("another candidate is refused", async () => {
    const { transcripts } = await setup();
    const { token: otherToken } = await createTalent();
    expect((await transcripts(otherToken)).status).toBe(403);
  });

  it("anonymous requests are refused and unknown interviews are not found", async () => {
    const { posterToken, interview } = await setup();
    const anonymous = await request(app).get(`/v1/interviews/${interview.id}/transcripts`);
    expect(anonymous.status).toBe(401);
    const missing = await request(app)
      .get("/v1/interviews/00000000-0000-4000-8000-000000000000/transcripts")
      .set("Authorization", `Bearer ${posterToken}`);
    expect(missing.status).toBe(404);
  });
});
