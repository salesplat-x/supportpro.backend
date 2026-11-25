import { body, query } from "express-validator";
import { paginationRules, idParam } from "./shared.js";
import { QuestionType } from "../types/enums.js";
import {
  ASSESSMENT_OPTION_COUNT,
  MAX_GENERATED_QUESTIONS_PER_REQUEST,
} from "../config/assessmentQuestions.js";

const DichotomyPair = ["EI", "SN", "TF", "JP"] as const;

export const createQuestionValidator = [
  body("role").notEmpty().withMessage("Role is required"),
  body("question").notEmpty().withMessage("Question text is required"),
  body("category").notEmpty().withMessage("Category is required"),
  body("criteria").notEmpty().withMessage("Criteria is required"),
];

export const questionIdParamValidator = [idParam("_id")];

export const answerPersonalizedValidator = [
  body("jobId").notEmpty().withMessage("jobId is required"),
  body("answers").isObject().withMessage("answers must be an object"),
];

export const evaluatePersonalityValidator = [
  body("jobId").notEmpty().withMessage("jobId is required"),
  body("answers").isObject().withMessage("answers must be an object"),
];

// qs turns `a[]=x` or a repeated key into an array, which validators check element by element.
const isPlainText = (value: unknown) => typeof value === "string";

export const getQuestionsValidator = [
  query("questionType")
    .custom(isPlainText)
    .withMessage("questionType must be a single value")
    .bail()
    .isIn(Object.values(QuestionType))
    .withMessage(`questionType must be one of: ${Object.values(QuestionType).join(", ")}`),
  query("jobId").optional().custom(isPlainText),
  query("roleId").optional().custom(isPlainText),
  query("talentId").optional().custom(isPlainText),
  ...paginationRules,
];

export const personalizedQuestionsValidator = [
  body("jobId").notEmpty().withMessage("jobId is required"),
  body("talentId").notEmpty().withMessage("talentId is required"),
  body("recruiterGuide").optional().isArray(),
  body("recruiterGuide.*").optional().isString(),
];

export const generatePersonalityQuestionsValidator = [
  body("jobId").notEmpty().withMessage("jobId is required"),
  body("dichotomyPair")
    .isIn(DichotomyPair)
    .withMessage(`dichotomyPair must be one of: ${DichotomyPair.join(", ")}`),
  body("count")
    .optional()
    .isInt({ min: 1 })
    .withMessage("count must be a positive integer")
    .toInt(),
];

export const ensurePersonalityQuestionsValidator = [
  body("jobId").notEmpty().withMessage("jobId is required"),
];

export const generateAssessmentQuestionsValidator = [
  body("jobId").custom(isPlainText).bail().isUUID().withMessage("jobId must be a valid job id"),
  body("count")
    .optional()
    .not()
    .isArray()
    .bail()
    .isInt({ min: 1, max: MAX_GENERATED_QUESTIONS_PER_REQUEST })
    .withMessage(`count must be a whole number from 1 to ${MAX_GENERATED_QUESTIONS_PER_REQUEST}`)
    .toInt(),
];

export const candidateAssessmentQuestionsValidator = [
  query("jobId").custom(isPlainText).bail().isUUID().withMessage("jobId must be a valid job id"),
];

export const companyAssessmentAnswersValidator = [
  body("jobId").custom(isPlainText).bail().isUUID().withMessage("jobId must be a valid job id"),
  body("answers")
    .isObject()
    .withMessage("answers must be an object")
    .custom((answers: Record<string, unknown>) => {
      const entries = Object.entries(answers);
      if (entries.length === 0) {
        throw new Error("answers must not be empty");
      }
      for (const [, value] of entries) {
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value >= ASSESSMENT_OPTION_COUNT
        ) {
          throw new Error(
            `Every answer must be an option number from 0 to ${ASSESSMENT_OPTION_COUNT - 1}`
          );
        }
      }
      return true;
    }),
];
