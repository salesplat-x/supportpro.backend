import { Router } from "express";

const router = Router();

import * as user from "../../controllers/v1/user";
import validate from "../../middlewares/v1/validators/validate";
import * as userValidator from "../../middlewares/v1/validators/user";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired, validateAccess } from "../../middlewares/v1/auth";
import { memoryUpload } from "../../middlewares/v1/multer";
import { Roles } from "../../typings/customs";

router.post(
  "/me/image",
  loginRequired,
  memoryUpload.single("image"),
  asyncHandler(user.uploadProfileImage)
);

router.post(
  "/profile/cv",
  validateAccess([Roles.Talent]),
  memoryUpload.single("cv"),
  asyncHandler(user.uploadCv)
);

router.patch(
  "/me",
  loginRequired,
  validate(userValidator.updateUser, { body: true }),
  asyncHandler(user.updateUser)
);

router.patch(
  "/profile",
  validateAccess([Roles.Talent]),
  validate(userValidator.updateProfile, { body: true }),
  asyncHandler(user.editProfile)
);

router.get("/me", loginRequired, asyncHandler(user.me));

router.get(
  "/profile/",
  validateAccess([Roles.Admin, Roles.Recruiter]),
  validate(userValidator.userProfiles, { query: true }),
  asyncHandler(user.viewProfiles)
);

router.get(
  "/profile/:_id",
  validateAccess([Roles.Admin, Roles.Recruiter]),
  validate(userValidator.userId, { params: true }),
  asyncHandler(user.viewProfile)
);

router.get(
  "/applications",
  validateAccess([Roles.Talent]),
  validate(userValidator.applications, { query: true }),
  asyncHandler(user.applications)
);

export default (app: Router) => app.use("/user", router);
