import { Router } from "express";
import * as controller from "../../controllers/v1/scout";
import { asyncHandler } from "../../middlewares/v1/handler";
import { validateAccess } from "../../middlewares/v1/auth";
import { memoryUpload } from "../../middlewares/v1/multer";
import {
  getScoutReports,
  validateCv,
  validateCvAndCoverLetter,
} from "../../middlewares/v1/validators/scout";
import { Roles } from "../../typings/customs";
import validate from "../../middlewares/v1/validators/validate";
const router = Router();
// const upload = multer({ dest: "uploads/"});

router.get(
  "/batch/:id",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  validate(getScoutReports, { params: true }),
  asyncHandler(controller.fetchScoutReports)
);

router.get(
  "/single/:id",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  validate(getScoutReports, { params: true }),
  asyncHandler(controller.fetchScoutReport)
);

router.post(
  "/cv-and-cover-letter",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  memoryUpload.fields([
    { name: "cv", maxCount: 1 },
    { name: "coverLetter", maxCount: 1 },
  ]),
  validateCvAndCoverLetter,
  asyncHandler(controller.scoutCvAndCl)
);

router.post(
  "/cv",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  memoryUpload.single("cv"),
  validateCv,
  asyncHandler(controller.scoutCv)
);

export default (app: Router) => app.use("/scout", router);
