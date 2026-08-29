import { Router } from "express";
import * as question from "../controllers/question.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import {
  validateAccess,
  loginRequired,
  requireCompletedProfile,
  requireVerifiedEmail,
} from "../middleware/auth.js";
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
  ensurePersonalityQuestionsValidator,
} from "../validators/question.js";

const router = Router();

router.post(
  "/",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(createQuestionValidator),
  asyncHandler(question.create)
);
router.get(
  "/",
  loginRequired,
  requireVerifiedEmail,
  requireCompletedProfile,
  validate(getQuestionsValidator),
  asyncHandler(question.fetchQuestions)
);
router.post(
  "/personalized",
  validateAccess([UserRole.Recruiter, UserRole.Talent]),
  requireVerifiedEmail,
  validate(personalizedQuestionsValidator),
  asyncHandler(question.generatePersonalizedQuestions)
);
router.post(
  "/personality",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(generatePersonalityQuestionsValidator),
  asyncHandler(question.generatePersonalityQuestion)
);
router.post(
  "/personality/ensure",
  validateAccess([UserRole.Recruiter, UserRole.Talent]),
  requireVerifiedEmail,
  validate(ensurePersonalityQuestionsValidator),
  asyncHandler(question.ensurePersonalityQuestions)
);
router.post(
  "/answer/prescreening",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  requireCompletedProfile,
  validate(answerPrescreeningValidator),
  asyncHandler(question.answerPrescreening)
);
router.post(
  "/answer/personality",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(evaluatePersonalityValidator),
  asyncHandler(question.evaluatePersonalityType)
);
router.post(
  "/answer/personalized",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(answerPersonalizedValidator),
  asyncHandler(question.answerPersonalizedQuestions)
);
router.get("/:_id", validate(questionIdParamValidator), asyncHandler(question.fetch));
router.delete(
  "/:_id",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(questionIdParamValidator),
  asyncHandler(question.deleteQuestion)
);

export default (app: Router) => app.use("/questions", router);
