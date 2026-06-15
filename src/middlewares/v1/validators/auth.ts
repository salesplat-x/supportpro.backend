import { Joi } from "../../../helpers/joi-extensions";

export const register = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required(),
    firstName: Joi.string().required(),
    lastName: Joi.string().required(),
    middleName: Joi.string().optional(),
    phone: Joi.string()
      // Validates international phone numbers starting with + followed by 7-15 digits.
      .phoneNumber()
      .optional()
      .label("Phone Number"),
    country: Joi.string().optional(),
    password: Joi.string()
      .min(8)
      .max(72)
      .pattern(/^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#.?&])[A-Za-z\d@$!%*#?.&]{8,}$/)
      .required()
      .messages({
        "string.pattern.base":
          "Password must contain at least one number, one letter and one special character",
        "string.min": "Password must be at least 8 characters long",
        "string.max": "Password must be at most 72 characters long",
      }),
  }),
}).required();

export const emailOnly = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required(),
  }),
}).required();

export const login = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required(),
  }),
}).required();

export const resetPassword = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string()
      .min(8)
      .max(72)
      .pattern(/^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#.?&])[A-Za-z\d@$!%*#?.&]{8,}$/)
      .required()
      .messages({
        "string.pattern.base":
          "Password must contain at least one number, one letter and one special character",
        "string.min": "Password must be at least 8 characters long",
        "string.max": "Password must be at most 72 characters long",
      }),
    otp: Joi.string().required(),
  }),
}).required();

export const changePassword = Joi.object({
  body: Joi.object({
    newPassword: Joi.string()
      .min(8)
      .max(72)
      .pattern(/^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#.?&])[A-Za-z\d@$!%*#?.&]{8,}$/)
      .required()
      .messages({
        "string.pattern.base":
          "Password must contain at least one number, one letter and one special character",
        "string.min": "Password must be at least 8 characters long",
        "string.max": "Password must be at most 72 characters long",
      }),
    oldPassword: Joi.string().required(),
  }),
}).required();
