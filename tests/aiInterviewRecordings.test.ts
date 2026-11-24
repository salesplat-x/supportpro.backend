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
  createAdmin,
  createRole,
  createJob,
  createApplication,
  createOrganization,
} from "./helpers/fixtures.js";
import { User } from "../src/entities/User.js";
import { AiInterview } from "../src/entities/AiInterview.js";
import { AiInterviewQuestion } from "../src/entities/AiInterviewQuestion.js";
import { ScreeningStage, type AiInterviewMode } from "../src/types/enums.js";
import * as Spaces from "../src/utils/integrations/spaces.js";
import { AddRecordingsToAiInterviewQuestions1789003100000 } from "../src/migrations/1789003100000-AddRecordingsToAiInterviewQuestions.js";

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

const mockConfigured = Spaces.isSpacesConfigured as jest.Mock;
const mockUpload = Spaces.uploadPrivateToSpaces as jest.Mock;

const MB = 1024 * 1024;

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
  mockConfigured.mockReturnValue(true);
});

async function setup(mode: AiInterviewMode = "audio_video") {
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
    mode,
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
  const url = (questionId = questions[0]!.id, interviewId = interview.id) =>
    `/v1/interviews/${interviewId}/questions/${questionId}/recording`;
  const upload = (
    token: string,
    body: Buffer = Buffer.from("fake-audio"),
    contentType = "audio/webm",
    path = url()
  ) =>
    request(app)
      .put(path)
      .set("Authorization", `Bearer ${token}`)
      .attach("recording", body, { filename: "answer.webm", contentType });
  const open = (token: string, path = url()) =>
    request(app).get(path).set("Authorization", `Bearer ${token}`);
  const reloadQuestion = (id = questions[0]!.id) =>
    testDataSource.getRepository(AiInterviewQuestion).findOneByOrFail({ id });
  return {
    poster,
    posterToken,
    teammateToken,
    talent,
    talentToken,
    interview,
    questions,
    url,
    upload,
    open,
    reloadQuestion,
  };
}

describe("uploading an answer recording", () => {
  it("stores the candidate's recording privately and records it on the question", async () => {
    const { talentToken, upload, reloadQuestion, interview } = await setup();
    const res = await upload(talentToken, Buffer.from("my answer"), "audio/webm");
    expect(res.status).toBe(200);

    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [, key, contentType] = mockUpload.mock.calls[0];
    expect(key).toMatch(new RegExp(`^interview-recordings/${interview.id}/`));
    expect(contentType).toBe("audio/webm");

    const question = await reloadQuestion();
    expect(question.recordingKey).toBe(key);
    expect(question.recordingMimeType).toBe("audio/webm");
    expect(question.recordingSize).toBe(Buffer.from("my answer").length);
    expect(question.recordedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(res.body)).not.toContain(key);
  });

  it("accepts a recording of exactly 25 MB and refuses anything larger", async () => {
    const { talentToken, upload } = await setup();
    expect((await upload(talentToken, Buffer.alloc(25 * MB))).status).toBe(200);
    const tooBig = await upload(talentToken, Buffer.alloc(25 * MB + 1));
    expect(tooBig.status).toBe(400);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it("refuses files that are not audio or video", async () => {
    const { talentToken, upload } = await setup();
    const res = await upload(talentToken, Buffer.from("%PDF"), "application/pdf");
    expect(res.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("refuses a video file on an audio-only interview", async () => {
    const { talentToken, upload } = await setup("audio");
    expect((await upload(talentToken, Buffer.from("v"), "video/webm")).status).toBe(400);
    expect((await upload(talentToken, Buffer.from("a"), "audio/webm")).status).toBe(200);
  });

  it("accepts a video file on an audio and video interview", async () => {
    const { talentToken, upload } = await setup("audio_video");
    expect((await upload(talentToken, Buffer.from("v"), "video/webm")).status).toBe(200);
  });

  it("only lets the candidate upload, not the company or a stranger", async () => {
    const { posterToken, upload } = await setup();
    const { token: strangerToken } = await createTalent();
    expect((await upload(posterToken)).status).toBe(403);
    expect((await upload(strangerToken)).status).toBe(403);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("refuses a second recording for an answered question and keeps the first", async () => {
    const { talentToken, upload, reloadQuestion } = await setup();
    await upload(talentToken, Buffer.from("first"));
    const firstKey = (await reloadQuestion()).recordingKey!;

    const again = await upload(talentToken, Buffer.from("second"));

    expect(again.status).toBe(409);
    const question = await reloadQuestion();
    expect(question.recordingKey).toBe(firstKey);
    expect(bucket.get(firstKey)!.buffer.toString()).toBe("first");
    expect(bucket.size).toBe(1);
  });

  it("answers 404 for a question that isn't in this interview", async () => {
    const other = await setup();
    const { talentToken, upload, url } = await setup();
    const res = await upload(talentToken, undefined, undefined, url(other.questions[0]!.id));
    expect(res.status).toBe(404);
  });

  it("answers 503 and stores nothing when recording storage isn't set up", async () => {
    mockConfigured.mockReturnValue(false);
    const { talentToken, upload, reloadQuestion } = await setup();
    const res = await upload(talentToken);
    expect(res.status).toBe(503);
    expect(mockUpload).not.toHaveBeenCalled();
    expect((await reloadQuestion()).recordingKey).toBeNull();
  });
});

describe("opening an answer recording", () => {
  async function withRecording() {
    const ctx = await setup();
    await ctx.upload(ctx.talentToken, Buffer.from("spoken answer"), "audio/webm");
    return ctx;
  }

  it("lets the candidate open their own recording", async () => {
    const { talentToken, open } = await withRecording();
    const res = await open(talentToken).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/webm");
    expect(res.headers["cache-control"]).toContain("private");
    expect(Buffer.from(res.body).toString()).toBe("spoken answer");
  });

  it("lets members of the company that posted the job open it", async () => {
    const { posterToken, teammateToken, open } = await withRecording();
    expect((await open(posterToken)).status).toBe(200);
    expect((await open(teammateToken)).status).toBe(200);
  });

  it("refuses a stranger", async () => {
    const { open } = await withRecording();
    const { token: otherTalent } = await createTalent();
    const { user: otherRecruiter, token: otherRecruiterToken } = await createRecruiter();
    await createOrganization(otherRecruiter);
    expect((await open(otherTalent)).status).toBe(403);
    expect((await open(otherRecruiterToken)).status).toBe(403);
  });

  it("refuses a platform admin too, since the plan names only the candidate and the company", async () => {
    const { open } = await withRecording();
    const { token: adminToken } = await createAdmin();
    expect((await open(adminToken)).status).toBe(403);
  });

  it("refuses anyone not logged in", async () => {
    const { url } = await withRecording();
    expect((await request(app).get(url())).status).toBe(401);
  });

  it("answers 404 when no recording has been uploaded yet", async () => {
    const { talentToken, open, url, questions } = await withRecording();
    expect((await open(talentToken, url(questions[1]!.id))).status).toBe(404);
  });
});

describe("AddRecordingsToAiInterviewQuestions migration", () => {
  const columns = async () =>
    (
      await testDataSource.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_interview_questions'`
      )
    ).map((r: { column_name: string }) => r.column_name);

  it("adds the recording columns and down removes them", async () => {
    const runner = testDataSource.createQueryRunner();
    const migration = new AddRecordingsToAiInterviewQuestions1789003100000();
    const added = ["recording_key", "recording_mime_type", "recording_size", "recorded_at"];
    try {
      for (const column of added) {
        await runner.query(`ALTER TABLE "ai_interview_questions" DROP COLUMN "${column}"`);
      }
      await migration.up(runner);
      expect(await columns()).toEqual(expect.arrayContaining(added));
      await migration.down(runner);
      const after = await columns();
      added.forEach((column) => expect(after).not.toContain(column));
      await migration.up(runner);
    } finally {
      await runner.release();
    }
  });
});
