import { Readable } from "stream";

jest.mock("axios");
jest.mock("../src/utils/retry.js", () => ({
  withRetry: (fn: () => Promise<unknown>) => fn(),
}));

// Re-created by load(): resetModules gives the integration its own mocked axios instance.
let post: jest.Mock;

const load = (overrides: Record<string, string | undefined> = {}) => {
  jest.resetModules();
  jest.doMock("../src/config/env.js", () => ({
    __esModule: true,
    default: {
      elevenlabsApiKey: "key-123",
      elevenlabsVoiceId: "voice/id",
      elevenlabsModelId: "model-1",
      ...overrides,
    },
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  post = require("axios").post as jest.Mock;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../src/utils/integrations/elevenlabs.js") as typeof import("../src/utils/integrations/elevenlabs");
};

describe("ElevenLabs integration", () => {
  it("authenticates with xi-api-key, not a Bearer token", async () => {
    const mod = load();
    post.mockResolvedValue({ data: new ArrayBuffer(3) });
    await mod.synthesizeSpeech("hello");

    const [url, payload, config] = post.mock.calls[0];
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
    expect(post.mock.calls[0][1]).toEqual({ text: "hello" });
  });

  it("uses the /stream endpoint and returns the response stream", async () => {
    const body = Readable.from(["x"]);
    const mod = load();
    post.mockResolvedValue({ data: body });
    const result = await mod.synthesizeSpeechStream("hello");

    expect(post.mock.calls[0][0]).toMatch(/\/stream$/);
    expect(post.mock.calls[0][2].responseType).toBe("stream");
    expect(result).toBe(body);
  });

  it("fails fast, without calling the API, when not configured", async () => {
    const mod = load({ elevenlabsApiKey: undefined });
    expect(mod.isElevenLabsConfigured()).toBe(false);
    await expect(mod.synthesizeSpeech("hello")).rejects.toThrow(/not configured/);
    expect(post).not.toHaveBeenCalled();
  });
});
