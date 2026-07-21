import { body, param } from "express-validator";
import { idParam } from "./shared.js";

const blankToUndefined = (value: unknown) => (value === "" || value === null ? undefined : value);

// Each MBTI dichotomy pair's question count has no default and no upper
// cap (any positive integer) but becomes required once personalityEvaluation
// is enabled, so requiredness is checked against the sibling field rather
// than a static rule.
const personalityCountValidator = (field: string) =>
  body(field)
    .customSanitizer(blankToUndefined)
    .custom((value, { req }) => {
      const enabled =
        req.body.personalityEvaluation === true || req.body.personalityEvaluation === "true";
      if (enabled && (value === undefined || value === null)) {
        throw new Error(`${field} is required when personalityEvaluation is enabled`);
      }
      return true;
    })
    .optional()
    .isInt({ min: 1 })
    .toInt();

export const createAIConfigValidator = [
  body("name").optional().trim(),
  body("prescreeningAssessment").isBoolean().withMessage("prescreeningAssessment must be boolean"),
  body("minPrescreeningScore").optional().isFloat({ min: 0 }).toFloat(),
  body("cvSimilarity").isBoolean().withMessage("cvSimilarity must be boolean"),
  body("minCvSimilarityScore").optional().isFloat({ min: 0 }).toFloat(),
  body("noOfCvSimilarCandidates").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("personalizedAssessment").isBoolean().withMessage("personalizedAssessment must be boolean"),
  body("noPersonalizedQuestions").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("personalityEvaluation").isBoolean().withMessage("personalityEvaluation must be boolean"),
  personalityCountValidator("noOfEIQuestions"),
  personalityCountValidator("noOfSNQuestions"),
  personalityCountValidator("noOfTFQuestions"),
  personalityCountValidator("noOfJPQuestions"),
  body("uploadedQuestions").optional().isArray(),
  body("uploadedQuestions.*").optional().isString(),
  body("recruiterGuide").optional().isString(),
];

export const updateAIConfigValidator = [
  param("_id").notEmpty().withMessage("AI Config ID is required"),
  body("name").optional().trim(),
  body("prescreeningAssessment").optional().isBoolean(),
  body("minPrescreeningScore").optional().isFloat({ min: 0 }).toFloat(),
  body("cvSimilarity").optional().isBoolean(),
  body("minCvSimilarityScore").optional().isFloat({ min: 0 }).toFloat(),
  body("noOfCvSimilarCandidates").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("personalizedAssessment").optional().isBoolean(),
  body("noPersonalizedQuestions").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("personalityEvaluation").optional().isBoolean(),
  personalityCountValidator("noOfEIQuestions"),
  personalityCountValidator("noOfSNQuestions"),
  personalityCountValidator("noOfTFQuestions"),
  personalityCountValidator("noOfJPQuestions"),
  body("uploadedQuestions").optional().isString(),
  body("recruiterGuide").optional().isString(),
];

export const aiConfigIdParamValidator = [idParam("_id")];
