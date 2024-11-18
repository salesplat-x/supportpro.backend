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
  loginRequired,
  validate(questionValidator.getQuestions, { query: true }),
  asyncHandler(question.fetchQuestions)
);

router.post(
  "/personalized",
  validateAccess([Roles.Recruiter, Roles.Talent]),
  validate(questionValidator.personalizedQuestions, { body: true }),
  asyncHandler(question.generatePersonalizedQuestions)
);

router.post(
  "/personality",
  validateAccess([Roles.Recruiter]),
  validate(questionValidator.generatePersonalityQuestions, { body: true }),
  asyncHandler(question.generatePersonalityQuestion)
);

router.post(
  "/answer/prescreening",
  validateAccess([Roles.Talent]),
  validate(questionValidator.answers, { body: true }),
  asyncHandler(question.answerPrescreening)
);

router.post(
  "/answer/personality",
  validateAccess([Roles.Talent]),
  validate(questionValidator.evaluatePersonality, { body: true }),
  asyncHandler(question.evaluatePersonalityType)
);

router.post(
  "/answer/personalized",
  validateAccess([Roles.Talent]),
  validate(questionValidator.answersPersonalized, { body: true }),
  asyncHandler(question.answerPersonalizedQuestions)
);

router.get(
  "/:_id",
  validate(questionValidator.id, { params: true }),
  asyncHandler(question.fetch)
);

export default (app: Router) => app.use("/questions", router);
