import { Router } from "express";

const router = Router();

import * as question from "../../controllers/v1/question";
import validate from "../../middlewares/v1/validators/validate";
import * as questionValidator from "../../middlewares/v1/validators/question";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired, validateAccess } from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

router.post(
  "/",
  validateAccess([Roles.Admin]),
  validate(questionValidator.question, { body: true }),
  asyncHandler(question.create)
);

router.get(
  "/",
  validateAccess([Roles.Admin, Roles.Recruiter]),
  validate(questionValidator.allQuestions, { query: true }),
  asyncHandler(question.fetchAll)
);

router.post(
  "/personalized",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  validate(questionValidator.personalizedQuestions, { body: true }),
  asyncHandler(question.personalizedQuestions)
);

router.post(
  "/personality",
  validateAccess([Roles.Recruiter]),
  validate(questionValidator.personalityQuestions, { body: true }),
  asyncHandler(question.personalityQuestion)
);

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
