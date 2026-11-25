import axios from "axios";
import { Readable } from "stream";
import env from "../../config/env.js";
import { withRetry } from "../retry.js";
import { recordAiCall, recordAiFailure } from "./ai/usage.js";

const BASE_URL = "https://api.elevenlabs.io/v1/text-to-speech";

/** True when the API key and voice are configured; voice replies fall back to a canned clip when not. */
export const isElevenLabsConfigured = (): boolean =>
  Boolean(env.elevenlabsApiKey && env.elevenlabsVoiceId);

/** The AI interviewer reads questions in its own Nigerian English voice, apart from Grace's. */
export const isInterviewVoiceConfigured = (): boolean =>
  Boolean(env.elevenlabsApiKey && env.elevenlabsInterviewVoiceId);

const request = (text: string, stream: boolean, voiceId = env.elevenlabsVoiceId) => {
  if (!env.elevenlabsApiKey || !voiceId) {
    throw new Error("ElevenLabs is not configured (ELEVENLABS_API_KEY and a voice id)");
  }
  const suffix = stream ? "/stream" : "";
  return {
    url: `${BASE_URL}/${encodeURIComponent(voiceId)}${suffix}`,
    payload: { text, ...(env.elevenlabsModelId ? { model_id: env.elevenlabsModelId } : {}) },
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      // ElevenLabs authenticates with `xi-api-key`, not a Bearer token.
      "xi-api-key": env.elevenlabsApiKey!,
    },
  };
};

export interface SpeechOptions {
  /** Aborted when the voice request's overall deadline passes. */
  signal?: AbortSignal;
  /** Defaults to Grace's voice. */
  voiceId?: string;
  /** The AI job the speech is for, on the admin's AI usage page. Defaults to Grace's replies. */
  feature?: string;
}

const ATTEMPTS = 2;
const MAX_ERROR_BODY_BYTES = 16_384;

// The request asks for audio, so an error body arrives as bytes or a stream. Reading it as JSON
// is what shows a quota refusal (`detail.status: quota_exceeded`) for what it is.
const readErrorBody = async (err: unknown): Promise<void> => {
  const response = (err as { response?: { data?: unknown } } | undefined)?.response;
  const data = response?.data;
  if (!response || !data) return;
  try {
    let text: string | undefined;
    if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
      text = Buffer.from(data as ArrayBuffer).toString("utf8");
    } else if (data instanceof Readable) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of data) {
        const piece = Buffer.from(chunk as Buffer);
        chunks.push(piece);
        size += piece.length;
        if (size >= MAX_ERROR_BODY_BYTES) break;
      }
      text = Buffer.concat(chunks).toString("utf8");
    }
    if (text) response.data = JSON.parse(text) as unknown;
  } catch {
    // Not JSON: the status alone describes the failure.
  }
};

const speak = async <T>(text: string, feature: string, post: () => Promise<T>): Promise<T> => {
  const ref = { provider: "elevenlabs", model: env.elevenlabsModelId || "default", feature };
  try {
    const result = await post();
    recordAiCall(ref, { characters: text.length });
    return result;
  } catch (err) {
    await readErrorBody(err);
    recordAiFailure(ref, err);
    throw err;
  }
};

/** Synthesizes `text` into a complete mp3 buffer. */
export const synthesizeSpeech = async (
  text: string,
  { signal, voiceId, feature = "voice_speech" }: SpeechOptions = {}
): Promise<Buffer> => {
  const { url, payload, headers } = request(text, false, voiceId);
  const response = await speak(text, feature, () =>
    withRetry(
      () =>
        axios.post<ArrayBuffer>(url, payload, {
          headers,
          responseType: "arraybuffer",
          timeout: env.voiceCallTimeoutMs,
          signal,
        }),
      { retries: ATTEMPTS, label: "ElevenLabs text-to-speech" }
    )
  );
  return Buffer.from(response.data);
};

/** Synthesizes `text` and returns the mp3 as a stream so audio can start playing early. */
export const synthesizeSpeechStream = async (
  text: string,
  { signal, feature = "voice_speech" }: SpeechOptions = {}
): Promise<Readable> => {
  const { url, payload, headers } = request(text, true);
  const response = await speak(text, feature, () =>
    withRetry(
      () =>
        axios.post<Readable>(url, payload, {
          headers,
          responseType: "stream",
          // Bounds the wait for the response to start; once audio flows the stream runs on.
          timeout: env.voiceCallTimeoutMs,
          signal,
        }),
      { retries: ATTEMPTS, label: "ElevenLabs text-to-speech stream" }
    )
  );
  return response.data;
};
