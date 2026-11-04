import { Router } from "express";
import * as documentCheck from "../controllers/documentCheck.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { signedDocumentCheckUpload } from "../middleware/multer.js";
import { documentCheckLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { documentCheckValidator } from "../validators/staff.js";

const router = Router();

router.post(
  "/",
  documentCheckLimiter,
  validate(documentCheckValidator),
  asyncHandler(documentCheck.checkCode, "check this document")
);

router.post(
  "/file",
  documentCheckLimiter,
  signedDocumentCheckUpload.single("file"),
  asyncHandler(documentCheck.checkFile, "check this document")
);

export default (app: Router) => app.use("/document-checks", router);
