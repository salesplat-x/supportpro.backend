import { Router } from "express";
import * as pay from "../controllers/pay.js";
import * as staff from "../controllers/staff.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { staffWriteLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  accessLogValidator,
  addShareGrantValidator,
  benefitIdValidator,
  createBenefitValidator,
  payPreviewValidator,
  setPayValidator,
  shareGrantIdValidator,
  updateBenefitValidator,
  createStaffValidator,
  endStaffValidator,
  listStaffValidator,
  companyParamValidator,
  staffIdValidator,
  staffOptionsValidator,
  updateStaffValidator,
} from "../validators/staff.js";

const router = Router({ mergeParams: true });

const recruiter = [validateAccess([UserRole.Recruiter]), requireVerifiedEmail];

router.get(
  "/access",
  ...recruiter,
  validate(companyParamValidator),
  asyncHandler(staff.access, "load your access to People")
);

router.get("/", ...recruiter, validate(listStaffValidator), asyncHandler(staff.list, "load staff"));

router.get(
  "/options",
  ...recruiter,
  validate(staffOptionsValidator),
  asyncHandler(staff.options, "load staff list")
);

router.get(
  "/access-log",
  ...recruiter,
  validate(accessLogValidator),
  asyncHandler(staff.accessLog, "load the access log")
);

router.get(
  "/benefits",
  ...recruiter,
  validate(companyParamValidator),
  asyncHandler(pay.listBenefits, "load benefits")
);

router.post(
  "/benefits",
  ...recruiter,
  validate(createBenefitValidator),
  asyncHandler(pay.createBenefit, "add benefit")
);

router.patch(
  "/benefits/:benefitId",
  ...recruiter,
  validate(updateBenefitValidator),
  asyncHandler(pay.updateBenefit, "update benefit")
);

router.delete(
  "/benefits/:benefitId",
  ...recruiter,
  validate(benefitIdValidator),
  asyncHandler(pay.deleteBenefit, "delete benefit")
);

router.post(
  "/pay/preview",
  ...recruiter,
  validate(payPreviewValidator),
  asyncHandler(pay.previewParagraph, "preview the pay paragraph")
);

router.post(
  "/",
  ...recruiter,
  staffWriteLimiter,
  validate(createStaffValidator),
  asyncHandler(staff.create, "add staff member")
);

router.get(
  "/:staffId",
  ...recruiter,
  validate(staffIdValidator),
  asyncHandler(staff.get, "load staff member")
);

router.patch(
  "/:staffId",
  ...recruiter,
  validate(updateStaffValidator),
  asyncHandler(staff.update, "update staff member")
);

router.post(
  "/:staffId/end",
  ...recruiter,
  validate(endStaffValidator),
  asyncHandler(staff.end, "end employment")
);

router.post(
  "/:staffId/invite",
  ...recruiter,
  staffWriteLimiter,
  validate(staffIdValidator),
  asyncHandler(staff.invite, "send invite")
);

router.get(
  "/:staffId/activity",
  ...recruiter,
  validate(staffIdValidator),
  asyncHandler(staff.activity, "load activity")
);

router.get(
  "/:staffId/pay",
  ...recruiter,
  validate(staffIdValidator),
  asyncHandler(pay.getPay, "load pay")
);

router.put(
  "/:staffId/pay",
  ...recruiter,
  validate(setPayValidator),
  asyncHandler(pay.setPay, "save pay")
);

router.post(
  "/:staffId/share-grants",
  ...recruiter,
  validate(addShareGrantValidator),
  asyncHandler(pay.addShareGrant, "add share grant")
);

router.delete(
  "/:staffId/share-grants/:grantId",
  ...recruiter,
  validate(shareGrantIdValidator),
  asyncHandler(pay.deleteShareGrant, "remove share grant")
);

export default (app: Router) => app.use("/organizations/:_id/staff", router);
