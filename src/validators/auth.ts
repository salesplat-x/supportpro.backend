import { body } from "express-validator";
import { passwordRules } from "./shared.js";

export const registerValidator = [
  body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
  body("firstName").notEmpty().trim().withMessage("First name is required"),
  body("lastName").notEmpty().trim().withMessage("Last name is required"),
  body("middleName").optional().trim(),
  body("country").optional().trim(),
  passwordRules("password"),
];

export const loginValidator = [
  body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
  body("password").notEmpty().withMessage("Password is required"),
];

export const emailOnlyValidator = [
  body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
];

export const resetPasswordValidator = [
  body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
  body("otp").notEmpty().withMessage("OTP is required"),
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
];
