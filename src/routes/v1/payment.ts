import { Router } from "express";

const router = Router();

import validate from "../../middlewares/v1/validators/validate";
import { asyncHandler } from "../../middlewares/v1/handler";
import * as controller from "../../controllers/v1/payment";
import * as paymentValidator from "../../middlewares/v1/validators/payment";
import { loginRequired } from "../../middlewares/v1/auth";
import { verifyWebhookIP } from "../../middlewares/v1/verifyWebhookIP";

router.post(
    "/",
    loginRequired,
    validate(paymentValidator.initializePayment, { body: true }),
    asyncHandler(controller.getPaymentLink)
);

router.get(
    "/",
    loginRequired,
    asyncHandler(controller.getPaymentRecords)
);

router.post(
  "/verify",
  validate(paymentValidator.verify, { body: true }),
  asyncHandler(controller.verify)
);

router.post(
  "/dwhdbwnmdn229dnjkdnn83/webhook",
  // verifyWebhookIP,
  asyncHandler(controller.paystackWebhook)
);

export default (app: Router) => app.use("/payments", router);
