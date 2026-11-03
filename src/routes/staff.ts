import { Router } from "express";
import * as contracts from "../controllers/contracts.js";
import * as pay from "../controllers/pay.js";
import * as staff from "../controllers/staff.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { companyDocumentUpload, notarizedScanUpload } from "../middleware/multer.js";
import { staffWriteLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  accessLogValidator,
  addTaskValidator,
  checklistDefaultsValidator,
  companyProfileValidator,
  importStaffValidator,
  notarizationValidator,
  taskIdValidator,
  addShareGrantValidator,
  benefitIdValidator,
  commissionPlanIdValidator,
  createCommissionPlanValidator,
  previewDocumentValidator,
  sendDocumentValidator,
  staffDocumentValidator,
  updateCommissionPlanValidator,
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
  "/org-chart",
  ...recruiter,
  validate(companyParamValidator),
  asyncHandler(staff.orgChart, "load the org chart")
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

router.get(
  "/export",
  ...recruiter,
  validate(companyParamValidator),
  asyncHandler(staff.exportStaff, "export staff")
);

router.post(
  "/import",
  ...recruiter,
  staffWriteLimiter,
  validate(importStaffValidator),
  asyncHandler(staff.importStaff, "import staff")
);

router.get(
  "/checklist-defaults",
  ...recruiter,
  validate(companyParamValidator),
  asyncHandler(staff.checklistDefaults, "load the default checklist")
);

router.put(
  "/checklist-defaults",
  ...recruiter,
  validate(checklistDefaultsValidator),
  asyncHandler(staff.saveChecklistDefaults, "save the default checklist")
);

router.get(
  "/company-profile",
  ...recruiter,
  validate(companyParamValidator),
  asyncHandler(staff.getCompanyProfile, "load the company profile")
);

router.put(
  "/company-profile",
  ...recruiter,
  validate(companyProfileValidator),
  asyncHandler(staff.saveCompanyProfile, "save the company profile")
);

router.post(
  "/company-profile/extract",
  ...recruiter,
  staffWriteLimiter,
  companyDocumentUpload.single("file"),
  validate(companyParamValidator),
  asyncHandler(staff.fillCompanyProfile, "read the company document")
);

router.get(
  "/commission-plans",
  ...recruiter,
  validate(companyParamValidator),
  asyncHandler(pay.listCommissionPlans, "load commission plans")
);

router.post(
  "/commission-plans",
  ...recruiter,
  validate(createCommissionPlanValidator),
  asyncHandler(pay.createCommissionPlan, "add commission plan")
);

router.put(
  "/commission-plans/:planId",
  ...recruiter,
  validate(updateCommissionPlanValidator),
  asyncHandler(pay.updateCommissionPlan, "save commission plan")
);

router.delete(
  "/commission-plans/:planId",
  ...recruiter,
  validate(commissionPlanIdValidator),
  asyncHandler(pay.deleteCommissionPlan, "delete commission plan")
);

router.get(
  "/headcount-cost",
  ...recruiter,
  validate(companyParamValidator),
  asyncHandler(pay.headcountCost, "load headcount cost")
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

router.get(
  "/:staffId/documents",
  ...recruiter,
  validate(staffIdValidator),
  asyncHandler(contracts.list, "load documents")
);

router.get(
  "/:staffId/documents/preview",
  ...recruiter,
  validate(previewDocumentValidator),
  asyncHandler(contracts.preview, "preview document")
);

router.post(
  "/:staffId/documents",
  ...recruiter,
  staffWriteLimiter,
  validate(sendDocumentValidator),
  asyncHandler(contracts.send, "send document")
);

router.post(
  "/:staffId/documents/:documentId/resend",
  ...recruiter,
  staffWriteLimiter,
  validate(staffDocumentValidator),
  asyncHandler(contracts.resend, "send document again")
);

router.post(
  "/:staffId/documents/:documentId/finalize",
  ...recruiter,
  staffWriteLimiter,
  validate(staffDocumentValidator),
  asyncHandler(contracts.retryFinalization, "finish the signed copy")
);

router.get(
  "/:staffId/documents/:documentId/pdf",
  ...recruiter,
  validate(staffDocumentValidator),
  asyncHandler(contracts.download, "download document")
);

router.patch(
  "/:staffId/documents/:documentId",
  ...recruiter,
  validate(notarizationValidator),
  asyncHandler(contracts.setNotarization, "update document")
);

router.post(
  "/:staffId/documents/:documentId/notarized-scan",
  ...recruiter,
  staffWriteLimiter,
  notarizedScanUpload.single("file"),
  validate(staffDocumentValidator),
  asyncHandler(contracts.uploadNotarizedScan, "attach notarized copy")
);

router.get(
  "/:staffId/documents/:documentId/notarized-scan",
  ...recruiter,
  validate(staffDocumentValidator),
  asyncHandler(contracts.downloadNotarizedScan, "download notarized copy")
);

router.get(
  "/:staffId/checklist",
  ...recruiter,
  validate(staffIdValidator),
  asyncHandler(staff.tasks, "load checklist")
);

router.post(
  "/:staffId/checklist",
  ...recruiter,
  validate(addTaskValidator),
  asyncHandler(staff.addTask, "add task")
);

router.delete(
  "/:staffId/checklist/:taskId",
  ...recruiter,
  validate(taskIdValidator),
  asyncHandler(staff.deleteTask, "remove task")
);

export default (app: Router) => app.use("/organizations/:_id/staff", router);
