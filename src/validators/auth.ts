import { body } from "express-validator";
import { passwordRules } from "./shared.js";

// Restricts the post-verification redirect to the apply wizard or a company
// invite or staff invite join page, so this field can never be used as an open redirect.
const redirectPathRule = body("redirectPath")
  .optional()
  .matches(/^\/apply\/[A-Za-z0-9-]+$|^\/join-company\/[a-f0-9]+$|^\/join-staff\/[a-f0-9]+$/)
  .withMessage("Invalid redirect path");

export const registerValidator = [
  body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
  body("firstName").notEmpty().trim().withMessage("First name is required"),
  body("lastName").notEmpty().trim().withMessage("Last name is required"),
  body("middleName").optional().trim(),
  body("country").optional().trim(),
  redirectPathRule,
  passwordRules("password"),
];

export const resendVerificationValidator = [redirectPathRule];

export const loginValidator = [
  body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
  body("password").notEmpty().withMessage("Password is required"),
];

export const emailOnlyValidator = [
  body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
];

export const resetTokenValidator = [
  body("token").notEmpty().withMessage("Reset token is required"),
];

export const resetPasswordValidator = [
  body("token").notEmpty().withMessage("Reset token is required"),
  passwordRules("password"),
];

export const changePasswordValidator = [
  body("oldPassword").notEmpty().withMessage("Current password is required"),
  passwordRules("newPassword"),
];

export const verifyEmailValidator = [
  body("token").notEmpty().withMessage("Verification token is required"),
];

export const changeEmailValidator = [
  body("newEmail").isEmail().normalizeEmail().withMessage("Valid email is required"),
  body("currentPassword").notEmpty().withMessage("Current password is required"),
  redirectPathRule,
];
