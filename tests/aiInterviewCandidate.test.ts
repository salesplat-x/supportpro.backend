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
import { AiInterview } from "../src/entities/AiInterview.js";
import { AiInterviewQuestion } from "../src/entities/AiInterviewQuestion.js";
import { ScreeningStage, type AiInterviewMode } from "../src/types/enums.js";

jest.mock("../src/utils/integrations/spaces.js", () => {
  const actual = jest.requireActual("../src/utils/integrations/spaces.js");
  return {
    ...actual,
    isSpacesConfigured: jest.fn(() => true),
    uploadPrivateToSpaces: jest.fn(async () => undefined),
  };
});

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

async function setup(mode: AiInterviewMode = "audio_video") {
  const { user: poster, token: posterToken } = await createRecruiter();
  const organization = await createOrganization(poster);
  const job = await createJob(poster, await createRole(), { organizationId: organization.id });
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
  const load = (token: string, interviewId = interview.id) =>
    request(app).get(`/v1/interviews/${interviewId}`).set("Authorization", `Bearer ${token}`);
  const markAnswered = (position: number) =>
    testDataSource.getRepository(AiInterviewQuestion).update(
      { interviewId: interview.id, position },
      {
        recordingKey: `interview-recordings/${interview.id}/${position}.webm`,
        recordingMimeType: "audio/webm",
        recordingSize: 10,
        recordedAt: new Date(),
      }
    );
  return { poster, posterToken, talent, talentToken, interview, questions, load, markAnswered };
}

describe("loading the candidate's interview", () => {
  it("returns the questions in order, with none answered and the first one next", async () => {
    const { talentToken, interview, load } = await setup();
    const res = await load(talentToken);
    expect(res.status).toBe(200);

    const data = res.body.data;
    expect(data.id).toBe(interview.id);
    expect(data.mode).toBe("audio_video");
    expect(data.totalQuestions).toBe(5);
    expect(data.answeredCount).toBe(0);
    expect(data.questions.map((q: { position: number }) => q.position)).toEqual([1, 2, 3, 4, 5]);
    expect(data.questions[0]).toMatchObject({
      position: 1,
      question: "Question 1?",
      answered: false,
    });
    expect(data.questions[0].recordedAt).toBeNull();
    expect(data.nextQuestionId).toBe(data.questions[0].id);
  });

  it("resumes at the next unanswered question after some answers are in", async () => {
    const { talentToken, load, markAnswered, questions } = await setup();
    await markAnswered(1);
    await markAnswered(2);
    const data = (await load(talentToken)).body.data;
    expect(data.answeredCount).toBe(2);
    expect(data.questions[1]).toMatchObject({ position: 2, answered: true });
    expect(data.questions[1].recordedAt).not.toBeNull();
    expect(data.nextQuestionId).toBe(questions[2]!.id);
  });

  it("skips a gap and resumes at the first unanswered question, not the last answered one", async () => {
    const { talentToken, load, markAnswered, questions } = await setup();
    await markAnswered(1);
    await markAnswered(3);
    const data = (await load(talentToken)).body.data;
    expect(data.nextQuestionId).toBe(questions[1]!.id);
  });

  it("reports no next question once every answer is in", async () => {
    const { talentToken, load, markAnswered } = await setup();
    for (const position of [1, 2, 3, 4, 5]) await markAnswered(position);
    const data = (await load(talentToken)).body.data;
    expect(data.answeredCount).toBe(5);
    expect(data.nextQuestionId).toBeNull();
  });

  it("never sends a storage key to the candidate", async () => {
    const { talentToken, load, markAnswered } = await setup();
    await markAnswered(1);
    const res = await load(talentToken);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("interview-recordings/");
    expect(JSON.stringify(res.body)).not.toContain("recordingKey");
  });

  it("refuses the company and strangers, and says 404 for an unknown interview", async () => {
    const { posterToken, load } = await setup();
    const { token: strangerToken } = await createTalent();
    expect((await load(posterToken)).status).toBe(403);
    expect((await load(strangerToken)).status).toBe(403);
    expect((await load(posterToken, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("refuses a request without a login", async () => {
    const { interview } = await setup();
    const res = await request(app).get(`/v1/interviews/${interview.id}`);
    expect(res.status).toBe(401);
  });
});
