import { body, param } from "express-validator";
import { idParam } from "./shared.js";

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
  body("noOfEIQuestions").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("noOfSNQuestions").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("noOfTFQuestions").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("noOfJPQuestions").optional().isInt({ min: 1, max: 20 }).toInt(),
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
  body("noOfEIQuestions").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("noOfSNQuestions").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("noOfTFQuestions").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("noOfJPQuestions").optional().isInt({ min: 1, max: 20 }).toInt(),
  body("uploadedQuestions").optional().isString(),
  body("recruiterGuide").optional().isString(),
];

export const aiConfigIdParamValidator = [idParam("_id")];
