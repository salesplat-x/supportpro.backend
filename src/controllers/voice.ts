import { Request, Response } from "express";
import { pipeline } from "stream";
import * as voiceService from "../services/voice.js";
import { voiceExtensionFor } from "../middleware/multer.js";
import { sendSuccessResponse } from "../utils/response.js";
import { ValidationError } from "../utils/errors/ValidationError.js";
import logger from "../utils/logger.js";

const audioInput = (req: Request): voiceService.VoiceAudioInput => {
  const file = req.file;
  if (!file || file.size === 0) {
    throw new ValidationError("No audio file provided");
  }
  // The upload filter has already rejected unknown types, so the extension always resolves.
  return { buffer: file.buffer, extension: voiceExtensionFor(file.mimetype) ?? "webm" };
};

const setAudioHeaders = (res: Response, fallback: boolean): void => {
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  // Lets the client show "Grace is unavailable" text alongside the canned clip.
  res.setHeader("X-Voice-Fallback", String(fallback));
  res.setHeader("Access-Control-Expose-Headers", "X-Voice-Fallback");
};

export const transcribe = async (req: Request, res: Response) => {
  const transcription = await voiceService.transcribe(audioInput(req));
  sendSuccessResponse(res, "Transcription successful", { transcription });
};

export const chat = async (req: Request, res: Response) => {
  const { audio, fallback } = await voiceService.voiceChat(audioInput(req));
  setAudioHeaders(res, fallback);
  res.setHeader("Content-Length", audio.length);
  res.send(audio);
};

export const stream = async (req: Request, res: Response) => {
  const { audio, fallback } = await voiceService.voiceChatStream(audioInput(req));
  setAudioHeaders(res, fallback);
  // Headers are already sent once audio starts flowing, so a mid-stream failure can only
  // cut the connection; pipeline() makes sure both ends are cleaned up when that happens.
  pipeline(audio, res, (err) => {
    if (err) logger.error(`Voice stream interrupted: ${err.message}`);
  });
};
