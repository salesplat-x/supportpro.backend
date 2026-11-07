import multer from "multer";
import { ValidationError } from "../utils/errors/ValidationError.js";

export const MAX_INTERVIEW_RECORDING_BYTES = 25 * 1024 * 1024;

export const isAudioOrVideo = (mimetype: string): boolean =>
  /^(audio|video)\//i.test(mimetype.trim());

export const interviewRecordingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_INTERVIEW_RECORDING_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!isAudioOrVideo(file.mimetype)) {
      cb(new ValidationError("A recording must be an audio or video file"));
      return;
    }
    cb(null, true);
  },
});
