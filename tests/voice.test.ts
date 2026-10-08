/**
 * Voice endpoints: auth, upload validation, and the rule that only upstream failures
 * (not the caller's bad audio) are answered with the canned fallback clip.
 * OpenAI and ElevenLabs are mocked, and no database is needed.
 */
import express from "express";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import request from "supertest";
import { errorHandler } from "../src/middleware/errorHandler.js";
import voiceRoutes from "../src/routes/voice.js";
import { transcribeAudio, generateVoiceReply } from "../src/utils/integrations/openai.js";
import { synthesizeSpeech, synthesizeSpeechStream } from "../src/utils/integrations/elevenlabs.js";

jest.mock("../src/middleware/auth.js", () => ({
  loginRequired: (req: any, res: any, next: any) => {
    if (!req.headers.authorization) {
      res.status(401).json({ success: false, error: { code: "AUTHENTICATION_ERROR" } });
      return;
    }
    req.user = { id: "user-1", emailVerifiedAt: new Date() };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../src/utils/integrations/openai.js", () => ({
  transcribeAudio: jest.fn(),
  generateVoiceReply: jest.fn(),
}));
jest.mock("../src/utils/integrations/elevenlabs.js", () => ({
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
  opts: { type?: string; data?: Buffer | null; auth?: boolean } = {}
) => {
  const { type = "audio/webm;codecs=opus", data = Buffer.from("audio"), auth = true } = opts;
  const req = request(app).post(`/v1/voice/${route}`);
  if (auth) req.set(AUTH);
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
    expect(mockTranscribe).toHaveBeenCalledWith(expect.any(Buffer), "voice.webm");
  });

  it("maps mp4 audio to m4a", async () => {
    await send("transcribe", { type: "audio/mp4" });
    expect(mockTranscribe).toHaveBeenCalledWith(expect.any(Buffer), "voice.m4a");
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
    expect(mockReply).toHaveBeenCalledWith("hello grace");
    expect(mockSpeech).toHaveBeenCalledWith("Hi there!");
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
    expect(mockSpeechStream).toHaveBeenCalledWith("Hi there!");
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
