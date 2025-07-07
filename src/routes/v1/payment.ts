import { Router } from "express";

const router = Router();

import validate from "../../middlewares/v1/validators/validate";
import { asyncHandler } from "../../middlewares/v1/handler";
import * as controller from "../../controllers/v1/payment";
import { verify } from "../../middlewares/v1/validators/payment";
import { loginRequired } from "../../middlewares/v1/auth";
import {verifyWebhookIP} from "../../middlewares/v1/verifyWebhookIP";


router.get(
    "/verify/:id",
    validate(verify, { params: true }),
    asyncHandler(controller.verify)
);

router.post("/",
    loginRequired,
    asyncHandler(controller.getPaymentLink));

router.post(
    "/webhook",
    verifyWebhookIP,
    asyncHandler(controller.paystackWebhook)
)

export default (app: Router) => app.use("/payments", router);