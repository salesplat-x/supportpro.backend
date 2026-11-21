import { body } from "express-validator";
import { idParam } from "./shared.js";
import {
  MAX_GENERATED_QUESTIONS,
  MAX_REFERENCE_QUESTION_LENGTH,
  MAX_REFERENCE_QUESTIONS,
  REFERENCE_QUESTION_TYPES,
} from "../services/referenceQuestions.js";

export const MAX_SEND_JOBS = 50;

export const organizationIdValidator = [idParam("_id")];

export const setReferenceQuestionsValidator = [
  idParam("_id"),
  body("questions")
    .isArray({ max: MAX_REFERENCE_QUESTIONS })
    .withMessage(`questions must list at most ${MAX_REFERENCE_QUESTIONS} questions`),
  body("questions.*.key").optional({ values: "null" }).isUUID().withMessage("key must be an id"),
  body("questions.*.question")
    .isString()
    .withMessage("question must be text")
    .bail()
    .trim()
    .isLength({ max: MAX_REFERENCE_QUESTION_LENGTH })
    .withMessage(`question must be at most ${MAX_REFERENCE_QUESTION_LENGTH} characters`),
  body("questions.*.type")
    .isIn([...REFERENCE_QUESTION_TYPES])
    .withMessage(`type must be one of: ${REFERENCE_QUESTION_TYPES.join(", ")}`),
  body("questions.*.required")
    .isBoolean({ strict: true })
    .withMessage("required must be true or false"),
];

export const generateReferenceQuestionsValidator = [
  idParam("_id"),
  body("count")
    .isInt({ min: 1, max: MAX_GENERATED_QUESTIONS })
    .withMessage(`count must be between 1 and ${MAX_GENERATED_QUESTIONS}`)
    .toInt(),
];

export const sendReferenceQuestionsValidator = [
  idParam("_id"),
  body("jobIds")
    .isArray({ min: 1, max: MAX_SEND_JOBS })
    .withMessage(`jobIds must list 1 to ${MAX_SEND_JOBS} jobs`),
  body("jobIds.*").isUUID().withMessage("each job id must be valid"),
];
