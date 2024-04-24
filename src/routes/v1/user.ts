import { Router } from "express";

const router = Router();

import * as user from "../../controllers/v1/user";
import validate from "../../middlewares/v1/validators/validate";
import * as userValidator from "../../middlewares/v1/validators/user";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired, validateAccess } from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

router.post(
  "/profile",
  validateAccess([Roles.Talent]),
  validate(userValidator.profile, { body: true }),
  asyncHandler(user.uploadProfile)
);

router.patch(
  "/profile",
  validateAccess([Roles.Talent]),
  validate(userValidator.profile, { body: true }),
  asyncHandler(user.editProfile)
);

router.get("/me", loginRequired, asyncHandler(user.me));

export default (app: Router) => app.use("/user", router);
