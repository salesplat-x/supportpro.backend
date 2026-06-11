import { Router } from "express";
import * as controller from "../../controllers/v1/scout";
import { asyncHandler } from "../../middlewares/v1/handler";
import { validateAccess } from "../../middlewares/v1/auth";
import * as multerUploads from "../../middlewares/v1/multer";
import * as scoutValidator from "../../middlewares/v1/validators/scout";
import { validateCv, validateCvAndCoverLetter } from "../../middlewares/v1/validators/scout";
import * as scoutJob from "../../controllers/v1/scoutJob";
import * as scoutJobValidator from "../../middlewares/v1/validators/scoutJob";
import { Roles } from "../../typings/customs";
import validate from "../../middlewares/v1/validators/validate";
const router = Router();

router.post(
  "/jobs/",
  validateAccess([Roles.Recruiter]),
  validate(scoutJobValidator.scoutJob, { body: true }),
  asyncHandler(scoutJob.create)
);

router.put(
  "/jobs/:_id",
  validateAccess([Roles.Recruiter]),
  validate(scoutJobValidator.updateScoutJob, { query: true }),
  asyncHandler(scoutJob.update)
);

router.get("/jobs/:_id", validateAccess([Roles.Recruiter]), asyncHandler(scoutJob.fetch));

router.get(
  "/:scoutJobId/talents",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  validate(scoutValidator.scoutTalents, { params: true, query: true }),
  asyncHandler(controller.scoutTalents)
);

router.get(
  "/batch/:id",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  validate(scoutValidator.getScoutReports, { params: true }),
  asyncHandler(controller.fetchScoutReports)
);

router.get(
  "/single/:id",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  validate(scoutValidator.getScoutReports, { params: true }),
  asyncHandler(controller.fetchScoutReport)
);

router.post(
  "/cv-and-cover-letter",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  multerUploads.memoryUpload.fields([
    { name: "cv", maxCount: 1 },
    { name: "coverLetter", maxCount: 1 },
  ]),
  validateCvAndCoverLetter,
  asyncHandler(controller.scoutCvAndCl)
);

router.post(
  "/cv",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  multerUploads.memoryUpload.single("cv"),
  validateCv,
  asyncHandler(controller.scoutCv)
);

export default (app: Router) => app.use("/scout", router);
