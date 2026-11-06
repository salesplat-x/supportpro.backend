/**
 * Voice calls get their own small concurrency pool, so a burst of long recordings can't
 * hold the 5 shared OpenAI slots that CV scoring, match verdicts and scouting depend on.
 */
const createTranscription = jest.fn();
const createCompletion = jest.fn();

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: createCompletion } },
    embeddings: { create: jest.fn() },
    audio: { transcriptions: { create: createTranscription } },
  })),
  toFile: jest.fn((_data: Buffer, name: string) => Promise.resolve({ name })),
}));
jest.mock("../src/utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { gradeAssessmentAnswers, transcribeAudio } from "../src/utils/integrations/openai.js";

interface Deferred {
  resolve: (value: unknown) => void;
}

/** Makes every transcription hang until released, like a slow Whisper upload. */
const holdTranscriptions = (): Deferred[] => {
  const held: Deferred[] = [];
  createTranscription.mockImplementation(
    () =>
      new Promise((resolve) => {
        held.push({ resolve });
      })
  );
  return held;
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Releases held calls, including ones that only started once a slot freed up. */
const releaseAll = async (held: Deferred[]) => {
  for (let round = 0; round < 6; round++) {
    held.forEach((d) => d.resolve({ text: "ok" }));
    await flush();
  }
};

const within = <T>(promise: Promise<T>, ms: number): Promise<T | "still waiting"> =>
  Promise.race([
    promise,
    new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), ms)),
  ]);

beforeEach(() => {
  createTranscription.mockReset();
  createCompletion.mockReset();
  createCompletion.mockResolvedValue({ choices: [{ message: { content: "{}" } }] });
});

describe("voice concurrency pool", () => {
  it("runs at most 2 transcriptions at once (VOICE_CONCURRENCY default)", async () => {
    const held = holdTranscriptions();
    const calls = [1, 2, 3].map(() => transcribeAudio(Buffer.from("a"), "voice.webm"));
    await flush();
    await flush();
    expect(createTranscription).toHaveBeenCalledTimes(2);

    await releaseAll(held);
    await Promise.all(calls);
    expect(createTranscription).toHaveBeenCalledTimes(3);
  });

  it("doesn't make CV scoring wait behind slow transcriptions", async () => {
    const held = holdTranscriptions();
    const voiceCalls = [1, 2, 3, 4, 5].map(() => transcribeAudio(Buffer.from("a"), "voice.webm"));
    await flush();

    const scoring = await within(gradeAssessmentAnswers("[]"), 1000);
    expect(scoring).not.toBe("still waiting");
    expect(createCompletion).toHaveBeenCalledTimes(1);

    await releaseAll(held);
    await Promise.all(voiceCalls);
  });
});
