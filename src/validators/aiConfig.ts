import { body, param } from "express-validator";
import { idParam } from "./shared.js";
import { MAX_ASSESSMENT_QUESTIONS_PER_CANDIDATE } from "../config/assessmentQuestions.js";

const blankToUndefined = (value: unknown) => (value === "" || value === null ? undefined : value);

const dichotomyPairFields = [
  "noOfEIQuestions",
  "noOfSNQuestions",
  "noOfTFQuestions",
  "noOfJPQuestions",
] as const;

// Each MBTI dichotomy pair's question count has no default and no upper cap
// (any positive integer), and none of them is individually required — but
// once personalityEvaluation is enabled, at least one of the four pairs must
// have a question count set (see atLeastOneDichotomyPairValidator below).
const personalityCountValidator = (field: string) =>
  body(field).customSanitizer(blankToUndefined).optional().isInt({ min: 1 }).toInt();

const assessmentCountValidator = (field: string) =>
  body(field)
    .customSanitizer(blankToUndefined)
    .optional()
    .isInt({ min: 1, max: MAX_ASSESSMENT_QUESTIONS_PER_CANDIDATE })
    .withMessage(
      `${field} must be a whole number from 1 to ${MAX_ASSESSMENT_QUESTIONS_PER_CANDIDATE}`
    )
    .toInt();

const assessmentSwitchValidators = [
  body("problemSolvingAssessment")
    .optional()
    .isBoolean()
    .withMessage("problemSolvingAssessment must be boolean")
    .toBoolean(),
  assessmentCountValidator("noOfProblemSolvingQuestions"),
  body("cultureFitAssessment")
    .optional()
    .isBoolean()
    .withMessage("cultureFitAssessment must be boolean")
    .toBoolean(),
  assessmentCountValidator("noOfCultureFitQuestions"),
];

const atLeastOneDichotomyPairValidator = body("personalityEvaluation").custom((_value, { req }) => {
  const enabled =
    req.body.personalityEvaluation === true || req.body.personalityEvaluation === "true";
  if (!enabled) return true;

  const hasAtLeastOne = dichotomyPairFields.some((field) => {
    const value = blankToUndefined(req.body[field]);
    return value !== undefined;
  });

  if (!hasAtLeastOne) {
    throw new Error(
      "At least one dichotomy pair (EI, SN, TF, JP) question count is required when personalityEvaluation is enabled"
    );
  }
  return true;
});

export const createAIConfigValidator = [
  body("jobId").notEmpty().withMessage("jobId is required"),
  body("name").optional().trim(),
  // prescreeningAssessment is always on server-side, regardless of what's sent here.
  body("prescreeningAssessment").optional().isBoolean(),
  body("minPrescreeningScore")
    .isFloat({ min: 0 })
    .withMessage("minPrescreeningScore is required")
    .toFloat(),
  body("cvSimilarity").isBoolean().withMessage("cvSimilarity must be boolean"),
  body("minCvSimilarityScore").optional().isFloat({ min: 0 }).toFloat(),
  body("personalizedAssessment").isBoolean().withMessage("personalizedAssessment must be boolean"),
  body("noPersonalizedQuestions").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("personalityEvaluation").isBoolean().withMessage("personalityEvaluation must be boolean"),
  personalityCountValidator("noOfEIQuestions"),
  personalityCountValidator("noOfSNQuestions"),
  personalityCountValidator("noOfTFQuestions"),
  personalityCountValidator("noOfJPQuestions"),
  atLeastOneDichotomyPairValidator,
  body("uploadedQuestions").optional().isArray(),
  body("uploadedQuestions.*").optional().isString(),
  body("recruiterGuide").optional().isString(),
  ...assessmentSwitchValidators,
];

export const updateAIConfigValidator = [
  param("_id").notEmpty().withMessage("AI Config ID is required"),
  body("name").optional().trim(),
  body("prescreeningAssessment").optional().isBoolean(),
  body("minPrescreeningScore").optional().isFloat({ min: 0 }).toFloat(),
  body("cvSimilarity").optional().isBoolean(),
  body("minCvSimilarityScore").optional().isFloat({ min: 0 }).toFloat(),
  body("personalizedAssessment").optional().isBoolean(),
  body("noPersonalizedQuestions").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("personalityEvaluation").optional().isBoolean(),
  personalityCountValidator("noOfEIQuestions"),
  personalityCountValidator("noOfSNQuestions"),
  personalityCountValidator("noOfTFQuestions"),
  personalityCountValidator("noOfJPQuestions"),
  atLeastOneDichotomyPairValidator,
  body("uploadedQuestions").optional().isArray(),
  body("uploadedQuestions.*").optional().isString(),
  body("recruiterGuide").optional().isString(),
  ...assessmentSwitchValidators,
];

export const aiConfigIdParamValidator = [idParam("_id")];
