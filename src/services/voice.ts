import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { generateVoiceReply, transcribeAudio } from "../utils/integrations/openai.js";
import {
  isElevenLabsConfigured,
  synthesizeSpeech,
  synthesizeSpeechStream,
} from "../utils/integrations/elevenlabs.js";
import { AudioUnreadableError, probeAudioDurationSeconds } from "../utils/audioDuration.js";
import { getErrorStatus } from "../utils/retry.js";
import env from "../config/env.js";
import { AppError } from "../utils/errors/AppError.js";
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

const UNREADABLE_AUDIO = "We couldn't read that audio. Please record it again.";

const describeLimit = (seconds: number): string => {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
};

/**
 * Whisper bills per minute and 10 MB of Opus can hold over an hour, so the length is checked
 * before anything is paid for. A missing ffprobe propagates as our failure (fail closed).
 */
const assertWithinLengthLimit = async (input: VoiceAudioInput, limit: number): Promise<number> => {
  let seconds: number;
  try {
    seconds = await probeAudioDurationSeconds(input.buffer, input.extension);
  } catch (err) {
    if (err instanceof AudioUnreadableError) {
      throw new ValidationError(UNREADABLE_AUDIO);
    }
    throw err;
  }
  if (seconds > limit) {
    throw new ValidationError(
      `That recording is too long. Please keep it under ${describeLimit(limit)}.`
    );
  }
  return seconds;
};

/** The voice request ran past its overall deadline. */
export class VoiceTimeoutError extends AppError {
  constructor() {
    super(504, "VOICE_TIMEOUT", "That took too long. Please try again in a moment.");
  }
}

/**
 * Runs `work` under the voice request's overall deadline (VOICE_REQUEST_DEADLINE_MS), kept
 * well inside Cloudflare's ~100 s cutoff so the user always gets our answer, never a 524.
 * When it passes, the signal aborts whatever provider call is still running.
 */
const withDeadline = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new VoiceTimeoutError());
    }, env.voiceRequestDeadlineMs);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

const transcribeWithin = async (
  input: VoiceAudioInput,
  signal: AbortSignal,
  maxSeconds: number = env.voiceMaxDurationSeconds
): Promise<string> => {
  const durationSeconds = await assertWithinLengthLimit(input, maxSeconds);
  let text: string;
  try {
    text = await transcribeAudio(input.buffer, `voice.${input.extension}`, {
      signal,
      durationSeconds,
    });
  } catch (err) {
    if (getErrorStatus(err) === 400) {
      throw new ValidationError(UNREADABLE_AUDIO);
    }
    throw err;
  }
  if (!text) {
    throw new ValidationError("We couldn't hear anything in that recording.");
  }
  return text;
};

/**
 * Speech-to-text only. Unreadable audio is the caller's problem (400); anything else is ours.
 * `maxSeconds` lets a caller with its own recording limit allow for the few seconds a browser
 * adds after it stops recording.
 */
export const transcribe = (
  input: VoiceAudioInput,
  { maxSeconds }: { maxSeconds?: number } = {}
): Promise<string> => withDeadline((signal) => transcribeWithin(input, signal, maxSeconds));

/**
 * Speech in, reply text out. Shared by the buffered and streamed endpoints so both fail
 * the same way: bad audio raises a ValidationError, anything else propagates to the caller.
 */
const reply = async (input: VoiceAudioInput, signal: AbortSignal): Promise<string> => {
  const userText = await transcribeWithin(input, signal);
  logger.info(`Voice message transcribed (${userText.length} chars)`);

  const aiReply = await generateVoiceReply(userText, { signal });
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

/**
 * Without text-to-speech there is no spoken reply to give, so transcribing and asking the
 * model would be paid for and thrown away. Answer with the fallback clip straight away.
 */
const voiceRepliesOff = (): boolean => {
  if (isElevenLabsConfigured()) return false;
  logger.warn("Voice replies are off (ElevenLabs is not configured); serving the fallback clip");
  if (!fs.existsSync(fallbackPath())) {
    throw new Error(`Voice fallback clip is missing at ${fallbackPath()}`);
  }
  return true;
};

/** Audio in, spoken reply out (complete mp3). */
export const voiceChat = async (input: VoiceAudioInput): Promise<VoiceAudioResult> => {
  if (voiceRepliesOff()) {
    return { audio: await fs.promises.readFile(fallbackPath()), fallback: true };
  }
  try {
    const audio = await withDeadline(async (signal) =>
      synthesizeSpeech(await reply(input, signal), { signal })
    );
    return { audio, fallback: false };
  } catch (err) {
    recoverWithFallback(err);
    return { audio: await fs.promises.readFile(fallbackPath()), fallback: true };
  }
};

/** Audio in, spoken reply streamed out so playback can begin before synthesis finishes. */
export const voiceChatStream = async (input: VoiceAudioInput): Promise<VoiceStreamResult> => {
  if (voiceRepliesOff()) {
    return { audio: fs.createReadStream(fallbackPath()), fallback: true };
  }
  try {
    // The deadline covers the wait for audio to start; once it flows the stream runs on.
    const audio = await withDeadline(async (signal) =>
      synthesizeSpeechStream(await reply(input, signal), { signal })
    );
    return { audio, fallback: false };
  } catch (err) {
    recoverWithFallback(err);
    return { audio: fs.createReadStream(fallbackPath()), fallback: true };
  }
};
