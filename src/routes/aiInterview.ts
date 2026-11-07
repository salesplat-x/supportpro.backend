import { Router } from "express";
import { param } from "express-validator";
import * as interview from "../controllers/aiInterview.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail } from "../middleware/auth.js";
import { interviewRecordingUpload } from "../middleware/interviewRecordingUpload.js";
import { validate } from "../middleware/validate.js";

const router = Router();

const interviewParams = [
  param("interviewId").isUUID().withMessage("interviewId must be a valid id"),
];

const recordingParams = [
  param("interviewId").isUUID().withMessage("interviewId must be a valid id"),
  param("questionId").isUUID().withMessage("questionId must be a valid id"),
];

router.get(
  "/:interviewId",
  loginRequired,
  requireVerifiedEmail,
  validate(interviewParams),
  asyncHandler(interview.getCandidateInterview, "load interview")
);

router.put(
  "/:interviewId/questions/:questionId/recording",
  loginRequired,
  requireVerifiedEmail,
  validate(recordingParams),
  interviewRecordingUpload.single("recording"),
  asyncHandler(interview.uploadRecording, "upload interview recording")
);
router.get(
  "/:interviewId/questions/:questionId/recording",
  loginRequired,
  requireVerifiedEmail,
  validate(recordingParams),
  asyncHandler(interview.openRecording, "open interview recording")
);

router.get(
  "/:interviewId/transcripts",
  loginRequired,
  requireVerifiedEmail,
  validate(interviewParams),
  asyncHandler(interview.getInterviewTranscripts, "load interview transcripts")
);

router.get(
  "/:interviewId/assessment",
  loginRequired,
  requireVerifiedEmail,
  validate(interviewParams),
  asyncHandler(interview.getInterviewAssessment, "load interview assessment")
);

export default (app: Router) => app.use("/interviews", router);
