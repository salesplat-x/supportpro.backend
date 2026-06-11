import { Router } from "express";

import * as message from "../../controllers/v1/message";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired, validateAccess } from "../../middlewares/v1/auth";
import validate from "../../middlewares/v1/validators/validate";
import * as validator from "../../middlewares/v1/validators/message";
import { Roles } from "../../typings/customs";

const router = Router();

router.post(
  "/broadcast",
  validateAccess([Roles.Recruiter]),
  validate(validator.broadcastMessage, { body: true }),
  asyncHandler(message.broadcastMessage)
);

router.patch(
  "/:id",
  validateAccess([Roles.Talent]),
  validate(validator.acknowledge, { params: true, body: true }),
  asyncHandler(message.acknowledge)
);
router.use(loginRequired);

router.post("/", validate(validator.sendMessage, { body: true }), asyncHandler(message.create));

router.get(
  "/",
  validate(validator.fetchApplicationMessages, { query: true }),
  asyncHandler(message.getMessages)
);

router.get("/:id", asyncHandler(message.getMessage));

// router.delete("/:id", asyncHandler(message.deleteMessage));

export default (app: Router) => app.use("/messages", router);
