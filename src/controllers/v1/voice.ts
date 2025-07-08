// Newly added file for Voice integration
import { Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { handleVoiceStreamInteraction } from "../../services/v1/voice";
import { sendSuccessResponse, sendErrorResponse } from "../../helpers/response";
import { handleVoiceInteraction } from "../../services/v1/voice";

// Config of multer storage (just temporary files)
const upload = multer({ dest: path.join(__dirname, "../../../tmp") });

/**
 * POST /v1/voice/transcribe
 * Accepts an audio file, returns the transcription text.
 */
export const transcribeEndpoint = [
  upload.single("audio"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      return sendErrorResponse(res, "No audio file provided", {}, 400);
    }

    try {
      const transcription = await handleVoiceInteraction(req.file.path);
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return sendSuccessResponse(res, "Transcription successful", { transcription });
    } catch (err: any) {
      return sendErrorResponse(res, err.message || "Voice transcription failed", {}, 500);
    }
  },
];

/**
 * POST /v1/voice/chat
 * Accepts an audio file, processes STT→Chat→TTS, and streams back mp3 audio
 */
export const chatEndpoint = [
  upload.single("audio"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      return sendErrorResponse(res, "No audio file provided", {}, 400);
    }

    try {
      const audioBuffer = await handleVoiceInteraction(req.file.path);
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

      // Send back as audio/mpeg stream
      res.set({
        "Content-Type": "audio/mpeg",
        "Content-Length": audioBuffer.length,
      });
      return res.send(audioBuffer);
    } catch (err: any) {
      return sendErrorResponse(res, err.message || "Voice chat failed", {}, 500);
    }
  },
];

/**
 * POST /v1/voice/stream
 * Accepts an audio file, processes STT→Chat→TTS as a stream, and pipes the mp3 back
 */
export const streamEndpoint = [
  upload.single("audio"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      return sendErrorResponse(res, "No audio file provided", {}, 400);
    }
    try {
      const stream = await handleVoiceStreamInteraction(req.file.path);
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

      res.setHeader("Content-Type", "audio/mpeg");
      return stream.pipe(res);
    } catch (err: any) {
      return sendErrorResponse(res, err.message || "Voice stream failed", {}, 500);
    }
  },
];

