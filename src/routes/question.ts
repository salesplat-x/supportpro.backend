import { Router } from "express";
import * as question from "../controllers/question.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, loginRequired, requireCompletedProfile } from "../middleware/auth.js";
import { UserRole } from "../types/enums.js";
import {
  createQuestionValidator,
  questionIdParamValidator,
  answerPrescreeningValidator,
  answerPersonalizedValidator,
  evaluatePersonalityValidator,
  getQuestionsValidator,
  personalizedQuestionsValidator,
  generatePersonalityQuestionsValidator,
} from "../validators/question.js";

const router = Router();

router.post(
  "/",
  validateAccess([UserRole.Admin]),
  validate(createQuestionValidator),
  asyncHandler(question.create)
);
router.get(
  "/",
  loginRequired,
  requireCompletedProfile,
  validate(getQuestionsValidator),
  asyncHandler(question.fetchQuestions)
);
router.post(
  "/personalized",
  validateAccess([UserRole.Recruiter, UserRole.Talent]),
  validate(personalizedQuestionsValidator),
  asyncHandler(question.generatePersonalizedQuestions)
);
router.post(
  "/personality",
  validateAccess([UserRole.Recruiter]),
  validate(generatePersonalityQuestionsValidator),
  asyncHandler(question.generatePersonalityQuestion)
);
router.post(
  "/answer/prescreening",
  validateAccess([UserRole.Talent]),
  requireCompletedProfile,
  validate(answerPrescreeningValidator),
  asyncHandler(question.answerPrescreening)
);
router.post(
  "/answer/personality",
  validateAccess([UserRole.Talent]),
  validate(evaluatePersonalityValidator),
  asyncHandler(question.evaluatePersonalityType)
);
router.post(
  "/answer/personalized",
  validateAccess([UserRole.Talent]),
  validate(answerPersonalizedValidator),
  asyncHandler(question.answerPersonalizedQuestions)
);
router.get("/:_id", validate(questionIdParamValidator), asyncHandler(question.fetch));

export default (app: Router) => app.use("/questions", router);
