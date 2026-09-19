import multer from "multer";

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
