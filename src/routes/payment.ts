import { Router } from "express";
import * as payment from "../controllers/payment.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail, validateAccess } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { initializePaymentValidator, verifyPaymentValidator } from "../validators/payment.js";
import { UserRole } from "../types/enums.js";

const router = Router();

router.post(
  "/",
  loginRequired,
  requireVerifiedEmail,
  validateAccess([UserRole.Recruiter]),
  validate(initializePaymentValidator),
  asyncHandler(payment.getPaymentLink, "start payment")
);
router.get(
  "/",
  loginRequired,
  requireVerifiedEmail,
  asyncHandler(payment.getPaymentRecords, "load payments")
);
router.post(
  "/verify",
  loginRequired,
  requireVerifiedEmail,
  validate(verifyPaymentValidator),
  asyncHandler(payment.verify, "verify payment")
);
router.post("/webhook", asyncHandler(payment.paystackWebhook, "process payment notification"));
router.post(
  "/dwhdbwnmdn229dnjkdnn83/webhook",
  asyncHandler(payment.paystackWebhook, "process payment notification")
);

export default (app: Router) => app.use("/payments", router);
