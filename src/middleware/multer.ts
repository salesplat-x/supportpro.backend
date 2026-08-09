import multer from "multer";

/** In-memory upload for CV multipart parsing (text is extracted; file is not persisted). */
export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
