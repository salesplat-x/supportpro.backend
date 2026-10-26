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
  generateAssessmentQuestionsValidator,
  candidateAssessmentQuestionsValidator,
} from "../validators/question.js";

const router = Router();

router.post(
  "/",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(createQuestionValidator),
  asyncHandler(question.create, "create question")
);
router.get(
  "/",
  loginRequired,
  requireVerifiedEmail,
  requireCompletedProfile,
  validate(getQuestionsValidator),
  asyncHandler(question.fetchQuestions, "load questions")
);
router.post(
  "/personalized",
  validateAccess([UserRole.Recruiter, UserRole.Talent]),
  requireVerifiedEmail,
  validate(personalizedQuestionsValidator),
  asyncHandler(question.generatePersonalizedQuestions, "generate personalized questions")
);
router.post(
  "/personality",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(generatePersonalityQuestionsValidator),
  asyncHandler(question.generatePersonalityQuestion, "generate personality question")
);
router.post(
  "/personality/ensure",
  validateAccess([UserRole.Recruiter, UserRole.Talent]),
  requireVerifiedEmail,
  validate(ensurePersonalityQuestionsValidator),
  asyncHandler(question.ensurePersonalityQuestions, "prepare personality questions")
);
router.post(
  "/problem-solving",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(generateAssessmentQuestionsValidator),
  asyncHandler(question.generateProblemSolvingQuestions, "generate problem-solving questions")
);
router.post(
  "/culture-fit",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(generateAssessmentQuestionsValidator),
  asyncHandler(question.generateCultureFitQuestions, "generate culture-fit questions")
);
router.get(
  "/candidate/problem-solving",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(candidateAssessmentQuestionsValidator),
  asyncHandler(question.candidateProblemSolvingQuestions, "load problem-solving questions")
);

router.get(
  "/candidate/culture-fit",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(candidateAssessmentQuestionsValidator),
  asyncHandler(question.candidateCultureFitQuestions, "load culture-fit questions")
);

router.post(
  "/answer/prescreening",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  requireCompletedProfile,
  validate(answerPrescreeningValidator),
  asyncHandler(question.answerPrescreening, "submit pre-screening answers")
);
router.post(
  "/answer/personality",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(evaluatePersonalityValidator),
  asyncHandler(question.evaluatePersonalityType, "submit personality answers")
);
router.post(
  "/answer/personalized",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(answerPersonalizedValidator),
  asyncHandler(question.answerPersonalizedQuestions, "submit personalized answers")
);
router.get(
  "/:_id",
  validate(questionIdParamValidator),
  asyncHandler(question.fetch, "load question")
);
router.delete(
  "/:_id",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(questionIdParamValidator),
  asyncHandler(question.deleteQuestion, "delete question")
);

export default (app: Router) => app.use("/questions", router);
