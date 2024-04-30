import { Router } from "express";

const router = Router();

import * as question from "../../controllers/v1/question";
import validate from "../../middlewares/v1/validators/validate";
import * as questionValidator from "../../middlewares/v1/validators/question";
import { asyncHandler } from "../../middlewares/v1/handler";
import { validateAccess } from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

router.post(
  "/",
  validateAccess([Roles.Admin]),
  validate(questionValidator.question, { body: true }),
  asyncHandler(question.create)
);

router.get("/", asyncHandler(question.fetchAll));

router.post(
  "/answer",
  validateAccess([Roles.Talent]),
  validate(questionValidator.answers, { body: true }),
  asyncHandler(question.answerQuestions)
);

router.get(
  "/:_id",
  validate(questionValidator.questionId, { params: true }),
  asyncHandler(question.fetch)
);

export default (app: Router) => app.use("/questions", router);
