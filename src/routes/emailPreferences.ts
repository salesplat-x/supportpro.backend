import { Request, Response, Router } from "express";
import { query } from "express-validator";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validate } from "../middleware/validate.js";
import { unsubscribeFromFollowUps } from "../services/stuckEmails.js";
import { sendSuccessResponse } from "../utils/response.js";

const router = Router();

const tokenValidator = [
  query("token").isString().isLength({ min: 1, max: 512 }).withMessage("This link isn't valid"),
];

/**
 * POST only, with no sign-in. Mail scanners open links in emails, so a GET must never
 * unsubscribe someone, and one-click unsubscribe requires a POST to this address.
 */
router.post(
  "/unsubscribe",
  validate(tokenValidator),
  asyncHandler(async (req: Request, res: Response) => {
    await unsubscribeFromFollowUps(req.query["token"] as string);
    sendSuccessResponse(res, "You won't get these reminders any more");
  }, "unsubscribe")
);

export default (app: Router) => app.use("/email-preferences", router);
