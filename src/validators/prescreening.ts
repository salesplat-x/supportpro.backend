import { body } from "express-validator";

export const submitPreScreeningValidator = [
  body("answers").isArray({ min: 1 }).withMessage("answers must be a non-empty array"),
  body("answers.*.questionId").notEmpty().withMessage("Each answer must have a questionId"),
  body("answers.*.selectedOption")
    .isInt({ min: -1, max: 3 })
    .withMessage("selectedOption must be -1 (unanswered) or 0-3"),
];
