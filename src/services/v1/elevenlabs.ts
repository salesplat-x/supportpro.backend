import axios from "axios";
import { Readable } from "stream";
import elevenLabsConfig from "../../config/elevenlabs";
import logger from "../../config/logger";

/**
 * Synthesizes text into speech audio using ElevenLabs API.
 * @param text is the input text to synthesize
 * @returns Buffer containing full audio data (mp3)
 */
export async function synthesizeTextToSpeech(text: string): Promise<Buffer> {
  const { apiKey, voiceId, modelId } = elevenLabsConfig;
  if (!voiceId) {
    throw new Error("ELEVENLABS_VOICE_ID is not configured");
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const payload: Record<string, any> = { text };
  if (modelId) payload.model_id = modelId;

  try {
    const response = await axios.post<ArrayBuffer>(
      url,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        responseType: "arraybuffer",
      }
    );

    return Buffer.from(response.data);
  } catch (error: any) {
    logger.logErrorMessage("ElevenLabs TTS Error: " + error.message);
    throw new Error("Text-to-speech synthesis failed");
  }
}

/**
 * Streams synthesized speech audio using ElevenLabs API.
 * @param text The input text to synthesize
 * @returns Readable stream of audio data (mp3)
 */
export async function synthesizeTextToSpeechStream(text: string): Promise<Readable> {
  const { apiKey, voiceId, modelId } = elevenLabsConfig;
  if (!voiceId) {
    throw new Error("ELEVENLABS_VOICE_ID is not configured");
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
  const payload: Record<string, any> = { text };
  if (modelId) payload.model_id = modelId;

  try {
    const response = await axios.post<Readable>(
      url,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        responseType: "stream",
      }
    );

    return response.data;
  } catch (error: any) {
    logger.logErrorMessage("ElevenLabs TTS Stream Error: " + error.message);
    throw new Error("Streaming text-to-speech synthesis failed");
  }
}
