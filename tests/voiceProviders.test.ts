/**
 * Voice calls must end well inside the proxy's ~100 s cutoff: short per-call timeouts, no
 * hidden SDK retries stacked on ours, at most 2 attempts, and the request's abort signal
 * passed through so a missed deadline stops the work.
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

import { generateVoiceReply, transcribeAudio } from "../src/utils/integrations/openai.js";

const upstreamError = (status: number) => Object.assign(new Error("upstream"), { status });

beforeEach(() => {
  createTranscription.mockReset();
  createCompletion.mockReset();
  createTranscription.mockResolvedValue({ text: " hello " });
  createCompletion.mockResolvedValue({ choices: [{ message: { content: " Hi! " } }] });
});

describe("transcribeAudio", () => {
  it("sets a 20 s per-call timeout, turns off SDK retries and passes the abort signal", async () => {
    const { signal } = new AbortController();
    await expect(transcribeAudio(Buffer.from("a"), "voice.webm", { signal })).resolves.toBe(
      "hello"
    );
    expect(createTranscription).toHaveBeenCalledWith(
      expect.objectContaining({ model: "whisper-1", file: { name: "voice.webm" } }),
      { timeout: 20_000, maxRetries: 0, signal }
    );
  });

  it("tries at most twice when the provider keeps failing", async () => {
    createTranscription.mockRejectedValue(upstreamError(503));
    await expect(transcribeAudio(Buffer.from("a"), "voice.webm")).rejects.toThrow("upstream");
    expect(createTranscription).toHaveBeenCalledTimes(2);
  });

  it("doesn't call the provider once the request has been abandoned", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      transcribeAudio(Buffer.from("a"), "voice.webm", { signal: controller.signal })
    ).rejects.toThrow();
    expect(createTranscription).not.toHaveBeenCalled();
  });
});

describe("generateVoiceReply", () => {
  it("uses the same per-call limits as transcription", async () => {
    const { signal } = new AbortController();
    await expect(generateVoiceReply("hello", { signal })).resolves.toBe("Hi!");
    expect(createCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o", max_tokens: 300 }),
      { timeout: 20_000, maxRetries: 0, signal }
    );
  });

  it("tries at most twice", async () => {
    createCompletion.mockRejectedValue(upstreamError(500));
    await expect(generateVoiceReply("hello")).rejects.toThrow("upstream");
    expect(createCompletion).toHaveBeenCalledTimes(2);
  });
});
