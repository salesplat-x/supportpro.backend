/**
 * Voice endpoints: auth, upload validation, and the rule that only upstream failures
 * (not the caller's bad audio) are answered with the canned fallback clip.
 * OpenAI and ElevenLabs are mocked, and no database is needed.
 */
import { execFile } from "child_process";
import express, { NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import request from "supertest";
import env from "../src/config/env.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import voiceRoutes from "../src/routes/voice.js";
import { transcribeAudio, generateVoiceReply } from "../src/utils/integrations/openai.js";
import {
  isElevenLabsConfigured,
  synthesizeSpeech,
  synthesizeSpeechStream,
} from "../src/utils/integrations/elevenlabs.js";

jest.mock("../src/middleware/auth.js", () => ({
  // Stands in for JWT checks: any Authorization header logs in. "X-Test-User" picks the user
  // id and "X-Test-Unverified" logs in someone who hasn't verified their email yet.
  loginRequired: (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.authorization) {
      res.status(401).json({ success: false, error: { code: "AUTHENTICATION_ERROR" } });
      return;
    }
    const id = req.header("x-test-user") ?? "user-1";
    const emailVerifiedAt = req.header("x-test-unverified") ? null : new Date();
    (req as unknown as { user: unknown }).user = { id, emailVerifiedAt };
    next();
  },
  // The real check, so an unverified user is refused exactly as in production.
  requireVerifiedEmail: jest.requireActual<typeof import("../src/middleware/auth")>(
    "../src/middleware/auth.js"
  ).requireVerifiedEmail,
}));

// ffprobe is stood in for, so the length check runs without the binary installed.
jest.mock("child_process", () => ({
  ...jest.requireActual<typeof import("child_process")>("child_process"),
  execFile: jest.fn(),
}));
jest.mock("../src/utils/integrations/openai.js", () => ({
  transcribeAudio: jest.fn(),
  generateVoiceReply: jest.fn(),
}));
jest.mock("../src/utils/integrations/elevenlabs.js", () => ({
  isElevenLabsConfigured: jest.fn(),
  synthesizeSpeech: jest.fn(),
  synthesizeSpeechStream: jest.fn(),
}));
jest.mock("../src/utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockTranscribe = transcribeAudio as jest.Mock;
const mockReply = generateVoiceReply as jest.Mock;
const mockSpeech = synthesizeSpeech as jest.Mock;
const mockSpeechStream = synthesizeSpeechStream as jest.Mock;
const mockExecFile = execFile as unknown as jest.Mock;
const mockTtsConfigured = isElevenLabsConfigured as jest.Mock;

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

/**
 * Answers ffprobe calls: the container-header query gets `formatDuration`, the packet scan
 * gets `packets`. Browser recordings (MediaRecorder webm) have no duration in the header.
 */
const fakeProbe = (formatDuration: string, packets = "") =>
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      cb(null, args.includes("format=duration") ? `${formatDuration}\n` : packets, "");
    }
  );

const probeFails = (err: Error) =>
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
      cb(err, "", "Invalid data found when processing input");
    }
  );

const errorMessage = (body: Buffer): string =>
  (JSON.parse(body.toString()) as { error: { message: string } }).error.message;

const setEnv = (key: string, value: unknown) => {
  (env as unknown as Record<string, unknown>)[key] = value;
};

const fallbackBytes = fs.readFileSync(path.join(process.cwd(), "templates", "fallback.mp3"));
const speech = Buffer.from("synthesised-mp3-bytes");
const AUTH = { Authorization: "Bearer test" };

const app = express();
const router = express.Router();
voiceRoutes(router);
app.use("/v1", router);
app.use(errorHandler);

const send = (
  route: string,
  opts: {
    type?: string;
    data?: Buffer | null;
    auth?: boolean;
    headers?: Record<string, string>;
  } = {}
) => {
  const { type = "audio/webm;codecs=opus", data = Buffer.from("audio"), auth = true } = opts;
  const req = request(app).post(`/v1/voice/${route}`);
  if (auth) req.set(AUTH);
  if (opts.headers) req.set(opts.headers);
  if (data) req.attach("audio", data, { filename: "blob", contentType: type });
  return req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
};

const upstreamError = (status: number) => Object.assign(new Error("upstream"), { status });

beforeEach(() => {
  jest.resetAllMocks();
  mockTranscribe.mockResolvedValue("hello grace");
  mockReply.mockResolvedValue("Hi there!");
  mockSpeech.mockResolvedValue(speech);
  mockSpeechStream.mockResolvedValue(Readable.from([speech]));
  fakeProbe("5.000000");
  mockTtsConfigured.mockReturnValue(true);
});

describe("auth and upload validation", () => {
  it.each(["transcribe", "chat", "stream"])("rejects unauthenticated %s", async (route) => {
    const res = await send(route, { auth: false });
    expect(res.status).toBe(401);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it.each(["transcribe", "chat", "stream"])("requires an audio file on %s", async (route) => {
    const res = await send(route, { data: null });
    expect(res.status).toBe(400);
  });

  it("rejects non-audio uploads before calling any provider", async () => {
    const res = await send("chat", { type: "application/pdf" });
    expect(res.status).toBe(400);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("rejects empty files", async () => {
    const res = await send("chat", { data: Buffer.alloc(0) });
    expect(res.status).toBe(400);
  });
});

describe("POST /voice/transcribe", () => {
  it("returns the transcription text, not audio", async () => {
    const res = await send("transcribe");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString()).data.transcription).toBe("hello grace");
    expect(mockSpeech).not.toHaveBeenCalled();
  });

  it("gives Whisper a supported extension even when the MIME type carries codecs", async () => {
    await send("transcribe", { type: "audio/webm;codecs=opus" });
    expect(mockTranscribe).toHaveBeenCalledWith(expect.any(Buffer), "voice.webm", {
      signal: expect.any(AbortSignal) as unknown,
    });
  });

  it("maps mp4 audio to m4a", async () => {
    await send("transcribe", { type: "audio/mp4" });
    expect(mockTranscribe).toHaveBeenCalledWith(expect.any(Buffer), "voice.m4a", {
      signal: expect.any(AbortSignal) as unknown,
    });
  });

  it("reports unreadable audio as a client error", async () => {
    mockTranscribe.mockRejectedValue(upstreamError(400));
    const res = await send("transcribe");
    expect(res.status).toBe(400);
  });

  it("reports a silent recording as a client error", async () => {
    mockTranscribe.mockResolvedValue("");
    const res = await send("transcribe");
    expect(res.status).toBe(400);
  });

  it("surfaces a provider outage instead of returning audio", async () => {
    mockTranscribe.mockRejectedValue(upstreamError(503));
    const res = await send("transcribe");
    expect(res.status).toBe(500);
  });
});

describe("POST /voice/chat", () => {
  it("returns the synthesised reply as audio/mpeg", async () => {
    const res = await send("chat");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");
    expect(res.headers["x-voice-fallback"]).toBe("false");
    expect(res.body).toEqual(speech);
    expect(mockReply).toHaveBeenCalledWith("hello grace", {
      signal: expect.any(AbortSignal) as unknown,
    });
    expect(mockSpeech).toHaveBeenCalledWith("Hi there!", {
      signal: expect.any(AbortSignal) as unknown,
    });
  });

  it("does not hide unreadable audio behind the fallback clip", async () => {
    mockTranscribe.mockRejectedValue(upstreamError(400));
    const res = await send("chat");
    expect(res.status).toBe(400);
    expect(mockReply).not.toHaveBeenCalled();
  });

  it.each([
    ["transcription is down", () => mockTranscribe.mockRejectedValue(upstreamError(503))],
    ["the model fails", () => mockReply.mockRejectedValue(upstreamError(500))],
    ["the model returns nothing", () => mockReply.mockResolvedValue("")],
    ["text-to-speech fails", () => mockSpeech.mockRejectedValue(upstreamError(401))],
  ])("serves the fallback clip when %s", async (_name, arrange) => {
    arrange();
    const res = await send("chat");
    expect(res.status).toBe(200);
    expect(res.headers["x-voice-fallback"]).toBe("true");
    expect(res.body).toEqual(fallbackBytes);
  });
});

describe("POST /voice/stream", () => {
  it("streams the synthesised reply", async () => {
    const res = await send("stream");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");
    expect(res.headers["x-voice-fallback"]).toBe("false");
    expect(res.body).toEqual(speech);
    expect(mockSpeechStream).toHaveBeenCalledWith("Hi there!", {
      signal: expect.any(AbortSignal) as unknown,
    });
  });

  it("streams the fallback clip when synthesis cannot start", async () => {
    mockSpeechStream.mockRejectedValue(upstreamError(500));
    const res = await send("stream");
    expect(res.status).toBe(200);
    expect(res.headers["x-voice-fallback"]).toBe("true");
    expect(res.body).toEqual(fallbackBytes);
  });

  it("rejects bad audio before streaming anything", async () => {
    mockTranscribe.mockResolvedValue("");
    const res = await send("stream");
    expect(res.status).toBe(400);
  });
});

describe("recording length cap", () => {
  const defaultMax = (env as unknown as Record<string, unknown>).voiceMaxDurationSeconds;
  afterEach(() => setEnv("voiceMaxDurationSeconds", defaultMax));

  it("defaults to 2 minutes", () => {
    expect(defaultMax).toBe(120);
  });

  it.each(["transcribe", "chat", "stream"])(
    "rejects a recording over the limit on %s before any paid call",
    async (route) => {
      fakeProbe("120.500000");
      const res = await send(route);
      expect(res.status).toBe(400);
      expect(errorMessage(res.body as Buffer)).toBe(
        "That recording is too long. Please keep it under 2 minutes."
      );
      expect(mockTranscribe).not.toHaveBeenCalled();
      expect(mockReply).not.toHaveBeenCalled();
      expect(mockSpeech).not.toHaveBeenCalled();
    }
  );

  it("accepts a recording exactly at the limit", async () => {
    fakeProbe("120.000000");
    const res = await send("transcribe");
    expect(res.status).toBe(200);
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
  });

  it("measures the upload with ffprobe", async () => {
    await send("transcribe");
    expect(mockExecFile).toHaveBeenCalledWith(
      "ffprobe",
      expect.arrayContaining(["-show_entries", "format=duration"]),
      expect.objectContaining({ timeout: expect.any(Number) as unknown }),
      expect.any(Function)
    );
  });

  it("counts packets when the header has no duration (browser webm)", async () => {
    const packets = Array.from(
      { length: 4 },
      (_, i) => `pts_time=${(i * 50).toFixed(6)}|duration_time=0.020000`
    ).join("\n");
    fakeProbe("N/A", `${packets}\n`);
    const res = await send("chat");
    expect(res.status).toBe(400);
    expect(errorMessage(res.body as Buffer)).toMatch(/too long/);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("lets a short browser webm through after counting its packets", async () => {
    fakeProbe(
      "N/A",
      "pts_time=0.000000|duration_time=0.020000\npts_time=2.980000|duration_time=0.020000\n"
    );
    const res = await send("transcribe");
    expect(res.status).toBe(200);
  });

  it("reports a file ffprobe cannot read as a client error, without calling Whisper", async () => {
    probeFails(Object.assign(new Error("Command failed: ffprobe"), { code: 1 }));
    const res = await send("transcribe");
    expect(res.status).toBe(400);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("treats audio with no measurable length as unreadable", async () => {
    fakeProbe("N/A", "");
    const res = await send("transcribe");
    expect(res.status).toBe(400);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("fails closed, without paying for Whisper, when ffprobe is missing", async () => {
    probeFails(Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" }));
    const transcribeRes = await send("transcribe");
    expect(transcribeRes.status).toBe(500);

    const chatRes = await send("chat");
    expect(chatRes.headers["x-voice-fallback"]).toBe("true");
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("uses VOICE_MAX_DURATION_SECONDS when it is set", async () => {
    setEnv("voiceMaxDurationSeconds", 30);
    fakeProbe("45.000000");
    const res = await send("transcribe");
    expect(res.status).toBe(400);
    expect(errorMessage(res.body as Buffer)).toBe(
      "That recording is too long. Please keep it under 30 seconds."
    );
  });
});

describe("when text-to-speech is not set up", () => {
  beforeEach(() => mockTtsConfigured.mockReturnValue(false));

  it.each(["chat", "stream"])(
    "%s answers with the fallback clip straight away, with no paid calls",
    async (route) => {
      const res = await send(route);
      expect(res.status).toBe(200);
      expect(res.headers["x-voice-fallback"]).toBe("true");
      expect(res.body).toEqual(fallbackBytes);
      expect(mockTranscribe).not.toHaveBeenCalled();
      expect(mockReply).not.toHaveBeenCalled();
      expect(mockSpeech).not.toHaveBeenCalled();
      expect(mockSpeechStream).not.toHaveBeenCalled();
    }
  );

  it("does not even measure the recording first", async () => {
    await send("chat");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("still requires an audio file", async () => {
    const res = await send("chat", { data: null });
    expect(res.status).toBe(400);
  });

  it("keeps transcription working, since it doesn't need text-to-speech", async () => {
    const res = await send("transcribe");
    expect(res.status).toBe(200);
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
  });
});

describe("overall request deadline", () => {
  const defaultDeadline = (env as unknown as Record<string, unknown>).voiceRequestDeadlineMs;
  beforeEach(() => setEnv("voiceRequestDeadlineMs", 200));
  afterEach(() => setEnv("voiceRequestDeadlineMs", defaultDeadline));

  /** A provider call that never answers, until the request's signal gives up on it. */
  const hangUntilAborted = (...args: unknown[]) =>
    new Promise((_resolve, reject) => {
      const options = args[args.length - 1] as { signal?: AbortSignal } | undefined;
      options?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("Request was aborted."), { name: "AbortError" }))
      );
    });

  it("defaults to 60 s, well under the proxy's ~100 s cutoff", () => {
    expect(defaultDeadline).toBe(60_000);
  });

  it.each([
    ["chat", "transcription hangs", () => mockTranscribe.mockImplementation(hangUntilAborted)],
    ["chat", "the model hangs", () => mockReply.mockImplementation(hangUntilAborted)],
    ["chat", "text-to-speech hangs", () => mockSpeech.mockImplementation(hangUntilAborted)],
    ["stream", "text-to-speech hangs", () => mockSpeechStream.mockImplementation(hangUntilAborted)],
  ])(
    "%s serves the fallback clip when %s past the deadline",
    async (route, _name, arrange) => {
      arrange();
      const started = Date.now();
      const res = await send(route);
      expect(res.status).toBe(200);
      expect(res.headers["x-voice-fallback"]).toBe("true");
      expect(res.body).toEqual(fallbackBytes);
      expect(Date.now() - started).toBeLessThan(2000);
    },
    5000
  );

  it("transcribe answers 504 when Whisper hangs past the deadline", async () => {
    mockTranscribe.mockImplementation(hangUntilAborted);
    const res = await send("transcribe");
    expect(res.status).toBe(504);
    expect(
      (JSON.parse((res.body as Buffer).toString()) as { error: { code: string } }).error.code
    ).toBe("VOICE_TIMEOUT");
  }, 5000);

  it("aborts the provider call it gave up on", async () => {
    let seen: AbortSignal | undefined;
    mockTranscribe.mockImplementation((...args: unknown[]) => {
      seen = (args[2] as { signal?: AbortSignal } | undefined)?.signal;
      return hangUntilAborted(...args);
    });
    await send("chat");
    expect(seen?.aborted).toBe(true);
  }, 5000);
});

describe("access and upload limits", () => {
  it.each(["transcribe", "chat", "stream"])(
    "refuses %s to a user who hasn't verified their email (403)",
    async (route) => {
      const res = await send(route, { headers: { "X-Test-Unverified": "1" } });
      expect(res.status).toBe(403);
      expect(
        (JSON.parse((res.body as Buffer).toString()) as { error: { code: string } }).error.code
      ).toBe("EMAIL_VERIFICATION_REQUIRED");
      expect(mockTranscribe).not.toHaveBeenCalled();
    }
  );

  it("rejects a file over 10 MB before measuring or transcribing it", async () => {
    const res = await send("transcribe", { data: Buffer.alloc(10 * 1024 * 1024 + 1) });
    expect(res.status).toBe(400);
    expect(
      (JSON.parse((res.body as Buffer).toString()) as { error: { code: string } }).error.code
    ).toBe("LIMIT_FILE_SIZE");
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  describe("rate limit", () => {
    const appEnv = env.app_env;
    // The limiter is skipped under NODE_ENV=test; switch it on for these requests only.
    beforeEach(() => setEnv("app_env", "dev"));
    afterEach(() => setEnv("app_env", appEnv));

    it("allows 20 voice requests per user in 15 minutes and refuses the 21st (429)", async () => {
      const headers = { "X-Test-User": "rate-limited-user" };
      for (let i = 0; i < 20; i++) {
        const ok = await send("transcribe", { headers });
        expect(ok.status).toBe(200);
      }
      const refused = await send("transcribe", { headers });
      expect(refused.status).toBe(429);
      expect(JSON.parse((refused.body as Buffer).toString())).toEqual({
        status: false,
        message:
          "You've sent a lot of voice messages recently — please try again in a few minutes.",
      });

      const otherUser = await send("transcribe", { headers: { "X-Test-User": "someone-else" } });
      expect(otherUser.status).toBe(200);
    });
  });
});
