import { Router } from "express";
import * as organization from "../controllers/organization.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate } from "../middleware/validate.js";
import { feedFileValidator } from "../validators/organization.js";

const router = Router();

router.get(
  "/:file",
  validate(feedFileValidator),
  asyncHandler(organization.getFeedXml, "load job feed")
);

export default (app: Router) => app.use("/feed", router);
