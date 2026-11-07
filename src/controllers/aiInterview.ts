import { Request, Response } from "express";
import * as recordings from "../services/aiInterviewRecording.js";

export const uploadRecording = async (req: Request, res: Response) => {
  const saved = await recordings.saveRecording(
    req.user.id,
    req.params["interviewId"]!,
    req.params["questionId"]!,
    req.file
  );
  res.status(200).json({ success: true, data: saved });
};

export const openRecording = async (req: Request, res: Response) => {
  const { buffer, mimeType } = await recordings.openRecording(
    req.user.id,
    req.params["interviewId"]!,
    req.params["questionId"]!
  );
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Cache-Control", "private, no-store");
  res.end(buffer);
};
