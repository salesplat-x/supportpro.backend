import { Router } from "express";
import * as contracts from "../controllers/contracts.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate } from "../middleware/validate.js";
import { documentTokenValidator, signDocumentValidator } from "../validators/staff.js";

const router = Router();

router.get(
  "/:token",
  validate(documentTokenValidator),
  asyncHandler(contracts.openLink, "load document")
);

router.post(
  "/:token/sign",
  validate(signDocumentValidator),
  asyncHandler(contracts.signWithLink, "sign document")
);

export default (app: Router) => app.use("/staff-documents", router);
