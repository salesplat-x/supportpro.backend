import { Router } from "express";

const router = Router();

import * as application from "../../controllers/v1/application";
import validate from "../../middlewares/v1/validators/validate";
import * as applicationValidator from "../../middlewares/v1/validators/application";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired } from "../../middlewares/v1/auth";

router.get(
  "/:_id",
  loginRequired,
  validate(applicationValidator.getApplication, { params: true }),
  asyncHandler(application.getApplication)
);

export default (app: Router) => app.use("/applications", router);
