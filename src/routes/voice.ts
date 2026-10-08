import { Router } from "express";
import * as voice from "../controllers/voice.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail } from "../middleware/auth.js";
import { voiceUpload } from "../middleware/multer.js";
import { voiceLimiter } from "../middleware/rateLimiter.js";

const router = Router();

router.use(loginRequired, requireVerifiedEmail, voiceLimiter);

// Audio in (multipart field "audio"), transcription text out.
router.post(
  "/transcribe",
  voiceUpload.single("audio"),
  asyncHandler(voice.transcribe, "transcribe your voice message")
);

// Audio in, complete spoken reply (audio/mpeg) out.
router.post(
  "/chat",
  voiceUpload.single("audio"),
  asyncHandler(voice.chat, "reply to your voice message")
);

// Audio in, spoken reply (audio/mpeg) streamed out as it is synthesised.
router.post(
  "/stream",
  voiceUpload.single("audio"),
  asyncHandler(voice.stream, "reply to your voice message")
);

export default (app: Router) => app.use("/voice", router);
