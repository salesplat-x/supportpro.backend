import axios from "axios";
import { Readable } from "stream";
import env from "../../config/env.js";
import { withRetry } from "../retry.js";

const BASE_URL = "https://api.elevenlabs.io/v1/text-to-speech";

/** True when the API key and voice are configured; voice replies fall back to a canned clip when not. */
export const isElevenLabsConfigured = (): boolean =>
  Boolean(env.elevenlabsApiKey && env.elevenlabsVoiceId);

const request = (text: string, stream: boolean) => {
  if (!isElevenLabsConfigured()) {
    throw new Error("ElevenLabs is not configured (ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID)");
  }
  const suffix = stream ? "/stream" : "";
  return {
    url: `${BASE_URL}/${encodeURIComponent(env.elevenlabsVoiceId!)}${suffix}`,
    payload: { text, ...(env.elevenlabsModelId ? { model_id: env.elevenlabsModelId } : {}) },
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      // ElevenLabs authenticates with `xi-api-key`, not a Bearer token.
      "xi-api-key": env.elevenlabsApiKey!,
    },
  };
};

/** Synthesizes `text` into a complete mp3 buffer. */
export const synthesizeSpeech = async (text: string): Promise<Buffer> => {
  const { url, payload, headers } = request(text, false);
  const response = await withRetry(
    () =>
      axios.post<ArrayBuffer>(url, payload, {
        headers,
        responseType: "arraybuffer",
        timeout: 30_000,
      }),
    { label: "ElevenLabs text-to-speech" }
  );
  return Buffer.from(response.data);
};

/** Synthesizes `text` and returns the mp3 as a stream so audio can start playing early. */
export const synthesizeSpeechStream = async (text: string): Promise<Readable> => {
  const { url, payload, headers } = request(text, true);
  const response = await withRetry(
    () =>
      axios.post<Readable>(url, payload, {
        headers,
        responseType: "stream",
        timeout: 30_000,
      }),
    { label: "ElevenLabs text-to-speech stream" }
  );
  return response.data;
};
