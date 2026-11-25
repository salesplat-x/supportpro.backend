import { Readable } from "stream";

jest.mock("axios");
const withRetry = jest.fn((fn: () => Promise<unknown>, _options?: unknown) => fn());
jest.mock("../src/utils/retry.js", () => ({
  withRetry: (fn: () => Promise<unknown>, options?: unknown) => withRetry(fn, options),
}));
const recordAiCall = jest.fn();
const recordAiFailure = jest.fn();
jest.mock("../src/utils/integrations/ai/usage.js", () => ({
  recordAiCall: (...args: unknown[]) => recordAiCall(...args),
  recordAiFailure: (...args: unknown[]) => recordAiFailure(...args),
}));

interface PostConfig {
  headers: Record<string, string | undefined>;
  responseType: string;
  timeout: number;
  signal?: AbortSignal;
}
type PostCall = [url: string, payload: Record<string, unknown>, config: PostConfig];

// Re-created by load(): resetModules gives the integration its own mocked axios instance.
let post: jest.Mock<Promise<unknown>, PostCall>;

const postCall = (index = 0): PostCall => {
  const call = post.mock.calls[index];
  if (!call) throw new Error(`axios.post was not called ${index + 1} time(s)`);
  return call;
};

const load = (overrides: Record<string, string | undefined> = {}) => {
  jest.resetModules();
  jest.doMock("../src/config/env.js", () => ({
    __esModule: true,
    default: {
      elevenlabsApiKey: "key-123",
      elevenlabsVoiceId: "voice/id",
      elevenlabsModelId: "model-1",
      voiceCallTimeoutMs: 20_000,
      ...overrides,
    },
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  post = (require("axios") as { post: typeof post }).post;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../src/utils/integrations/elevenlabs.js") as typeof import("../src/utils/integrations/elevenlabs");
};

describe("ElevenLabs integration", () => {
  it("authenticates with xi-api-key, not a Bearer token", async () => {
    const mod = load();
    post.mockResolvedValue({ data: new ArrayBuffer(3) });
    await mod.synthesizeSpeech("hello");

    const [url, payload, config] = postCall();
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid");
    expect(payload).toEqual({ text: "hello", model_id: "model-1" });
    expect(config.headers["xi-api-key"]).toBe("key-123");
    expect(config.headers.Authorization).toBeUndefined();
    expect(config.responseType).toBe("arraybuffer");
  });

  it("omits model_id when none is configured", async () => {
    const mod = load({ elevenlabsModelId: undefined });
    post.mockResolvedValue({ data: new ArrayBuffer(1) });
    await mod.synthesizeSpeech("hello");
    expect(postCall()[1]).toEqual({ text: "hello" });
  });

  it("uses the /stream endpoint and returns the response stream", async () => {
    const body = Readable.from(["x"]);
    const mod = load();
    post.mockResolvedValue({ data: body });
    const result = await mod.synthesizeSpeechStream("hello");

    expect(postCall()[0]).toMatch(/\/stream$/);
    expect(postCall()[2].responseType).toBe("stream");
    expect(result).toBe(body);
  });

  it("fails fast, without calling the API, when not configured", async () => {
    const mod = load({ elevenlabsApiKey: undefined });
    expect(mod.isElevenLabsConfigured()).toBe(false);
    await expect(mod.synthesizeSpeech("hello")).rejects.toThrow(/not configured/);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ["synthesizeSpeech", { data: new ArrayBuffer(1) }],
    ["synthesizeSpeechStream", { data: Readable.from(["x"]) }],
  ] as const)(
    "%s uses the voice per-call timeout, the abort signal and at most 2 attempts",
    async (fn, response) => {
      const mod = load();
      post.mockResolvedValue(response);
      withRetry.mockClear();
      const { signal } = new AbortController();
      await mod[fn]("hello", { signal });

      const config = postCall()[2];
      expect(config.timeout).toBe(20_000);
      expect(config.signal).toBe(signal);
      expect(withRetry).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ retries: 2 })
      );
    }
  );
  it("records the characters spoken, for the admin's AI usage page", async () => {
    const mod = load();
    post.mockResolvedValue({ data: new ArrayBuffer(1) });
    recordAiCall.mockClear();
    await mod.synthesizeSpeech("hello", { feature: "interview_question_audio" });

    expect(recordAiCall).toHaveBeenCalledWith(
      { provider: "elevenlabs", model: "model-1", feature: "interview_question_audio" },
      { characters: 5 }
    );
  });

  it("reads a quota refusal sent as audio bytes, so it can count as out of credit", async () => {
    const mod = load();
    const body = Buffer.from(
      JSON.stringify({ detail: { status: "quota_exceeded", message: "Over your quota." } })
    );
    const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.length);
    post.mockRejectedValue(
      Object.assign(new Error("Request failed with status code 401"), {
        response: { status: 401, data: arrayBuffer },
      })
    );
    recordAiFailure.mockClear();

    await expect(mod.synthesizeSpeech("hello")).rejects.toThrow(/401/);

    const [, err] = recordAiFailure.mock.calls[0] as [unknown, { response: { data: unknown } }];
    expect(err.response.data).toEqual({
      detail: { status: "quota_exceeded", message: "Over your quota." },
    });
  });
});
