import multer from "multer";
import { ValidationError } from "../utils/errors/ValidationError.js";

/** In-memory CV upload — text is extracted and the file is stored to DO Spaces. */
export const cvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

/** In-memory avatar upload, stored to DO Spaces. */
export const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

export const notarizedScanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

export const completionEvidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/** Only the text is read; the document itself is not stored. */
export const companyDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** In-memory job description upload — only its text is read, the file is not stored. */
export const jobDescriptionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

/**
 * Audio formats Whisper accepts, keyed by MIME type. The value is the file extension we
 * hand to Whisper: multer's in-memory files keep the client's filename, which browsers
 * often omit or get wrong for recorded blobs.
 */
export const VOICE_MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
};

export const voiceExtensionFor = (mimetype: string): string | undefined =>
  VOICE_MIME_EXTENSIONS[(mimetype.split(";")[0] ?? "").trim().toLowerCase()];

/** In-memory voice upload — audio is sent straight to speech-to-text and never stored. */
export const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!voiceExtensionFor(file.mimetype)) {
      cb(new ValidationError("Unsupported audio format. Use webm, ogg, mp3, m4a, wav or flac."));
      return;
    }
    cb(null, true);
  },
});

/** Public route: only hashed, never stored. A signed contract is far smaller than this. */
export const signedDocumentCheckUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
