import { Router } from "express";
import * as payment from "../controllers/payment.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { initializePaymentValidator, verifyPaymentValidator } from "../validators/payment.js";

const router = Router();

router.post(
  "/",
  loginRequired,
  requireVerifiedEmail,
  validate(initializePaymentValidator),
  asyncHandler(payment.getPaymentLink)
);
router.get("/", loginRequired, requireVerifiedEmail, asyncHandler(payment.getPaymentRecords));
router.post("/verify", validate(verifyPaymentValidator), asyncHandler(payment.verify));
// Obfuscated webhook path
router.post("/dwhdbwnmdn229dnjkdnn83/webhook", asyncHandler(payment.paystackWebhook));

export default (app: Router) => app.use("/payments", router);
