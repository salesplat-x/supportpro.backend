import { Request, Response } from "express";
import * as recordings from "../services/aiInterviewRecording.js";
import * as candidateInterviews from "../services/aiInterviewCandidate.js";
import * as transcripts from "../services/aiInterviewTranscript.js";
import * as assessments from "../services/aiInterviewScoring.js";

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

export const getCandidateInterview = async (req: Request, res: Response) => {
  const interview = await candidateInterviews.getCandidateInterview(
    req.user.id,
    req.params["interviewId"]!
  );
  res.status(200).json({ success: true, data: interview });
};

export const getInterviewTranscripts = async (req: Request, res: Response) => {
  const data = await transcripts.getCompanyInterviewTranscripts(
    req.user.id,
    req.params["interviewId"]!
  );
  res.status(200).json({ success: true, data });
};

export const getInterviewAssessment = async (req: Request, res: Response) => {
  const data = await assessments.getCompanyInterviewAssessment(
    req.user.id,
    req.params["interviewId"]!
  );
  res.status(200).json({ success: true, data });
};
