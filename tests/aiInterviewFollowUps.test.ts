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
import { reconcileDueInterviewTranscripts } from "../src/services/aiInterviewTranscript.js";
import {
  AI_FOLLOW_UP_MAX_CHARS,
  MAX_AI_INTERVIEW_FOLLOW_UPS,
  parseAiInterviewFollowUp,
} from "../src/services/aiInterviewFollowUp.js";

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
    probeAudioDurationSeconds: jest.fn(async () => 3),
  };
});

jest.mock("../src/utils/integrations/openai.js", () => ({
  ...jest.requireActual("../src/utils/integrations/openai.js"),
  transcribeAudio: jest.fn(),
  generateAiInterviewFollowUp: jest.fn(),
}));

const mockTranscribe = OpenAI.transcribeAudio as jest.Mock;
const mockFollowUp = OpenAI.generateAiInterviewFollowUp as jest.Mock;

const SHORT_WEBM = () =>
  fs.readFileSync(path.join(__dirname, "fixtures", "voice-3s-no-duration.webm"));
const ANSWER = "I led the onboarding team for two years and cut the backlog by half.";

const aiReply = (content: unknown) => ({
  message: { content: typeof content === "string" ? content : JSON.stringify(content) },
});

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
});

afterEach(async () => {
  await clearAllTables();
  bucket.clear();
  jest.clearAllMocks();
});

async function setup(extraQuestions: { position: number; question: string }[] = []) {
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
  const interview = await testDataSource.getRepository(AiInterview).save({
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
  for (const extra of extraQuestions) {
    await questionRepo.save({ interviewId: interview.id, isFollowUp: true, ...extra });
  }
  const upload = (token: string, questionId: string) =>
    request(app)
      .put(`/v1/interviews/${interview.id}/questions/${questionId}/recording`)
      .set("Authorization", `Bearer ${token}`)
      .attach("recording", SHORT_WEBM(), { filename: "answer.webm", contentType: "audio/webm" });
  const rows = () =>
    questionRepo.find({
      where: { interviewId: interview.id },
      order: { position: "ASC", isFollowUp: "ASC" },
    });
  const reload = (id: string) => questionRepo.findOneByOrFail({ id });
  const loadAsCandidate = (token: string) =>
    request(app).get(`/v1/interviews/${interview.id}`).set("Authorization", `Bearer ${token}`);
  const transcripts = (token: string) =>
    request(app)
      .get(`/v1/interviews/${interview.id}/transcripts`)
      .set("Authorization", `Bearer ${token}`);
  return {
    interview,
    questions,
    talentToken,
    teammateToken,
    upload,
    rows,
    reload,
    loadAsCandidate,
    transcripts,
    questionRepo,
  };
}

describe("asking a follow-up after an answer", () => {
  it("asks one follow-up once an answer's transcript is saved", async () => {
    mockFollowUp.mockResolvedValueOnce(
      aiReply({ followUp: "Which part of that backlog work was the hardest?" })
    );
    const { talentToken, questions, upload, rows, reload } = await setup();
    await upload(talentToken, questions[0]!.id);

    await reconcileDueInterviewTranscripts();

    expect(mockFollowUp).toHaveBeenCalledTimes(1);
    expect(mockFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ question: "Question 1?", answer: ANSWER })
    );
    const all = await rows();
    expect(all.map((row) => [row.position, row.isFollowUp])).toEqual([
      [1, false],
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [5, false],
    ]);
    const followUp = all[1]!;
    expect(followUp.question).toBe("Which part of that backlog work was the hardest?");
    expect(followUp.recordedAt).toBeNull();
    expect((await reload(questions[0]!.id)).transcriptStatus).toBe("completed");
  });

  it("adds no follow-up when none is needed", async () => {
    const { talentToken, questions, upload, rows, reload } = await setup();
    await upload(talentToken, questions[0]!.id);

    await reconcileDueInterviewTranscripts();

    expect(mockFollowUp).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(5);
    expect((await reload(questions[0]!.id)).transcript).toBe(ANSWER);
  });

  it.each([
    ["a follow-up that is not text", { followUp: 42 }],
    ["an empty follow-up", { followUp: "   " }],
    ["a follow-up over the length limit", { followUp: "x".repeat(AI_FOLLOW_UP_MAX_CHARS + 1) }],
    ["a reply that is not JSON", "not json at all"],
  ])("adds no follow-up for %s, and keeps the transcript", async (_label, reply) => {
    mockFollowUp.mockResolvedValueOnce(aiReply(reply));
    const { talentToken, questions, upload, rows, reload } = await setup();
    await upload(talentToken, questions[0]!.id);

    await reconcileDueInterviewTranscripts();

    expect(await rows()).toHaveLength(5);
    const question = await reload(questions[0]!.id);
    expect(question.transcriptStatus).toBe("completed");
    expect(question.transcript).toBe(ANSWER);
  });

  it("a failed follow-up request adds no follow-up and does not hold back the transcript", async () => {
    mockFollowUp.mockRejectedValueOnce(new Error("socket hang up"));
    const { talentToken, questions, upload, rows, reload } = await setup();
    await upload(talentToken, questions[0]!.id);

    await expect(reconcileDueInterviewTranscripts()).resolves.toEqual({ scanned: 1 });

    expect(await rows()).toHaveLength(5);
    expect((await reload(questions[0]!.id)).transcriptStatus).toBe("completed");
  });

  it("an interview never gets more than two follow-ups", async () => {
    expect(MAX_AI_INTERVIEW_FOLLOW_UPS).toBe(2);
    const { talentToken, questions, upload, rows } = await setup([
      { position: 2, question: "Follow-up on question 2?" },
      { position: 4, question: "Follow-up on question 4?" },
    ]);
    await upload(talentToken, questions[0]!.id);

    await reconcileDueInterviewTranscripts();

    expect(mockFollowUp).not.toHaveBeenCalled();
    expect((await rows()).filter((row) => row.isFollowUp)).toHaveLength(2);
  });

  it("a follow-up answer does not lead to another follow-up", async () => {
    const { talentToken, rows, upload } = await setup([
      { position: 2, question: "Follow-up on question 2?" },
    ]);
    const followUp = (await rows()).find((row) => row.isFollowUp)!;
    await upload(talentToken, followUp.id);

    await reconcileDueInterviewTranscripts();

    expect(mockFollowUp).not.toHaveBeenCalled();
    expect((await rows()).filter((row) => row.isFollowUp)).toHaveLength(1);
  });

  it("a question that already has a follow-up gets no second one", async () => {
    const { talentToken, questions, upload, rows } = await setup([
      { position: 1, question: "Follow-up on question 1?" },
    ]);
    await upload(talentToken, questions[0]!.id);

    await reconcileDueInterviewTranscripts();

    expect(mockFollowUp).not.toHaveBeenCalled();
    expect((await rows()).filter((row) => row.isFollowUp)).toHaveLength(1);
  });
});

describe("the candidate answers a follow-up on the same page", () => {
  it("lists the follow-up after its question and resumes there", async () => {
    const { talentToken, questions, rows, loadAsCandidate, questionRepo } = await setup([
      { position: 1, question: "Follow-up on question 1?" },
    ]);
    await questionRepo.update(questions[0]!.id, { recordedAt: new Date() });
    const followUp = (await rows()).find((row) => row.isFollowUp)!;

    const res = await loadAsCandidate(talentToken);

    expect(res.status).toBe(200);
    const listed = res.body.data.questions as Array<Record<string, unknown>>;
    expect(listed.map((q) => [q["position"], q["isFollowUp"]])).toEqual([
      [1, false],
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [5, false],
    ]);
    expect(res.body.data.nextQuestionId).toBe(followUp.id);
    expect(listed[0]).not.toHaveProperty("transcript");
  });

  it("uploads the candidate's answer to the follow-up", async () => {
    const { talentToken, rows, upload, reload } = await setup([
      { position: 1, question: "Follow-up on question 1?" },
    ]);
    const followUp = (await rows()).find((row) => row.isFollowUp)!;

    const res = await upload(talentToken, followUp.id);

    expect(res.status).toBe(200);
    expect((await reload(followUp.id)).recordedAt).toBeInstanceOf(Date);
  });
});

describe("the company reads a follow-up with its transcript", () => {
  it("shows the follow-up flag and its transcript to the posting company", async () => {
    const { talentToken, teammateToken, rows, upload, transcripts } = await setup([
      { position: 1, question: "Follow-up on question 1?" },
    ]);
    const followUp = (await rows()).find((row) => row.isFollowUp)!;
    await upload(talentToken, followUp.id);
    await reconcileDueInterviewTranscripts();

    const res = await transcripts(teammateToken);

    expect(res.status).toBe(200);
    const entry = res.body.data.questions.find((q: { isFollowUp: boolean }) => q.isFollowUp);
    expect(entry).toMatchObject({ position: 1, isFollowUp: true, transcript: ANSWER });
  });
});

describe("parsing the follow-up reply", () => {
  it("reads a follow-up question and returns null when none is needed", () => {
    expect(parseAiInterviewFollowUp(JSON.stringify({ followUp: " Why? " }))).toBe("Why?");
    expect(parseAiInterviewFollowUp(JSON.stringify({ followUp: null }))).toBeNull();
    expect(parseAiInterviewFollowUp(undefined)).toBeNull();
  });
});
