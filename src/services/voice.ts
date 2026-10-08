import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { generateVoiceReply, transcribeAudio } from "../utils/integrations/openai.js";
import { synthesizeSpeech, synthesizeSpeechStream } from "../utils/integrations/elevenlabs.js";
import { getErrorStatus } from "../utils/retry.js";
import { ValidationError } from "../utils/errors/ValidationError.js";
import logger from "../utils/logger.js";

export interface VoiceAudioInput {
  buffer: Buffer;
  /** Extension Whisper uses to recognise the format, without the dot. */
  extension: string;
}

export interface VoiceAudioResult {
  audio: Buffer;
  /** True when the canned clip was returned because an upstream service failed. */
  fallback: boolean;
}

export interface VoiceStreamResult {
  audio: Readable;
  fallback: boolean;
}

const fallbackPath = (): string => path.join(process.cwd(), "templates", "fallback.mp3");

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Speech-to-text only. Unreadable audio is the caller's problem (400); anything else is ours. */
export const transcribe = async (input: VoiceAudioInput): Promise<string> => {
  let text: string;
  try {
    text = await transcribeAudio(input.buffer, `voice.${input.extension}`);
  } catch (err) {
    if (getErrorStatus(err) === 400) {
      throw new ValidationError("We couldn't read that audio. Please record it again.");
    }
    throw err;
  }
  if (!text) {
    throw new ValidationError("We couldn't hear anything in that recording.");
  }
  return text;
};

/**
 * Speech in, reply text out. Shared by the buffered and streamed endpoints so both fail
 * the same way: bad audio raises a ValidationError, anything else propagates to the caller.
 */
const reply = async (input: VoiceAudioInput): Promise<string> => {
  const userText = await transcribe(input);
  logger.info(`Voice message transcribed (${userText.length} chars)`);

  const aiReply = await generateVoiceReply(userText);
  if (!aiReply) {
    throw new Error("The model returned an empty reply");
  }
  return aiReply;
};

/**
 * Only the user's own mistakes (bad or empty audio) are reported as errors. A failure in
 * an upstream service is ours, not theirs, so it is logged loudly and answered with the
 * canned clip rather than a failed request.
 */
const recoverWithFallback = (err: unknown): void => {
  if (err instanceof ValidationError) throw err;
  logger.error(`Voice pipeline failed, serving fallback audio: ${describe(err)}`);
  if (!fs.existsSync(fallbackPath())) {
    throw new Error(`Voice fallback clip is missing at ${fallbackPath()}`);
  }
};

/** Audio in, spoken reply out (complete mp3). */
export const voiceChat = async (input: VoiceAudioInput): Promise<VoiceAudioResult> => {
  try {
    const text = await reply(input);
    return { audio: await synthesizeSpeech(text), fallback: false };
  } catch (err) {
    recoverWithFallback(err);
    return { audio: await fs.promises.readFile(fallbackPath()), fallback: true };
  }
};

/** Audio in, spoken reply streamed out so playback can begin before synthesis finishes. */
export const voiceChatStream = async (input: VoiceAudioInput): Promise<VoiceStreamResult> => {
  try {
    const text = await reply(input);
    return { audio: await synthesizeSpeechStream(text), fallback: false };
  } catch (err) {
    recoverWithFallback(err);
    return { audio: fs.createReadStream(fallbackPath()), fallback: true };
  }
};
