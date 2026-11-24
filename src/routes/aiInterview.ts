import { Router } from "express";
import { body, param } from "express-validator";
import { SCREEN_EVENT_KINDS } from "../entities/AiInterviewScreenEvent.js";
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
  "/:interviewId/questions/:questionId/audio",
  loginRequired,
  requireVerifiedEmail,
  validate(recordingParams),
  asyncHandler(interview.questionAudio, "play interview question")
);

const screenEventParams = [
  ...interviewParams,
  body("kind")
    .isIn([...SCREEN_EVENT_KINDS])
    .withMessage("Unknown screen event"),
  body("questionId")
    .optional({ values: "null" })
    .isUUID()
    .withMessage("questionId must be a valid id"),
];

router.post(
  "/:interviewId/screen-events",
  loginRequired,
  requireVerifiedEmail,
  validate(screenEventParams),
  asyncHandler(interview.recordScreenEvent, "record leaving the interview screen")
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
