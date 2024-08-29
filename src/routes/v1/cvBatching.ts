import { Router } from "express";
import * as controller from "../../controllers/v1/cvBatching";
import { asyncHandler } from "../../middlewares/v1/handler";
import { validateAccess } from "../../middlewares/v1/auth";
import { memoryUpload } from "../../middlewares/v1/multer";
import { validateCvAndCoverLetter } from "../../middlewares/v1/validators/cvBatching";
import { Roles } from "../../typings/customs";
const router = Router();
// const upload = multer({ dest: "uploads/"});

router.post(
  "/cv-and-cover-letter",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  memoryUpload.fields([
    { name: "cv", maxCount: 1 },
    { name: "coverLetter", maxCount: 1 },
  ]),
  validateCvAndCoverLetter,
  asyncHandler(controller.cvAndCoverLetter)
);

export default (app: Router) => app.use("/cv-batching", router);
