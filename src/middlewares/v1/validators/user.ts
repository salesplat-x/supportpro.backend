import { Joi } from "../../../helpers/joi-extensions";
import { ExperienceLevel } from "../../../typings/customs";
import { FetchProfiles, IUser } from "../../../typings/user";
import { ApplicationStatus, ApplicationType } from "../../../typings/application";

export const profile = Joi.object({
  body: Joi.object({
    bio: Joi.string().max(1000).required(),
    cv: Joi.string().required(),
    location: Joi.object({
      city: Joi.string().optional(),
      state: Joi.string().required(),
      country: Joi.string().required(),
    }).required(),
    remote: Joi.boolean().required(),
    onSite: Joi.boolean().required(),
    hybrid: Joi.boolean().required(),
    experience: Joi.string()
      .required()
      .valid(...Object.values(ExperienceLevel)),
    maxSalary: Joi.number().max(100000000).min(0).required(),
    minSalary: Joi.number().max(100000000).min(0).less(Joi.ref("maxSalary")).required(),
    role: Joi.array().items(Joi.string()),
  }),
}).required();

export const updateProfile = Joi.object({
  body: Joi.object({
    bio: Joi.string().max(1000).optional(),
    cv: Joi.string().optional(),
    remote: Joi.boolean().required(),
    onSite: Joi.boolean().required(),
    hybrid: Joi.boolean().required(),
    location: Joi.object({
      city: Joi.string().optional(),
      state: Joi.string().required(),
      country: Joi.string().required(),
    }).optional(),
    experience: Joi.string()
      .optional()
      .valid(...Object.values(ExperienceLevel)),
    maxSalary: Joi.number().max(100000000).min(0).optional(),
    minSalary: Joi.number().max(100000000).min(0).less(Joi.ref("maxSalary")).optional(),
    role: Joi.array().items(Joi.string()),
  }),
}).required();

export const userId = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
}).required();

export const userProfiles = Joi.object({
  query: Joi.object({
    limit: Joi.number(),
    offset: Joi.number(),
    sort: Joi.string().valid("asc", "desc"),
    roleId: Joi.string().optional(),
    experience: Joi.string()
      .valid(...Object.values(ExperienceLevel))
      .optional(),
    minScore: Joi.number().max(99).min(0).optional(),
    maxSalary: Joi.number().max(100000000).min(0).optional(),
    incomplete: Joi.boolean().optional(),
  }),
}).required();

export const applications = Joi.object({
  query: Joi.object({
    applicationType: Joi.string()
      .valid(...Object.values(ApplicationType))
      .optional(),
    applicationStatus: Joi.string()
      .valid(...Object.values(ApplicationStatus))
      .optional(),
    limit: Joi.number(),
    offset: Joi.number(),
    sort: Joi.string().valid("asc", "desc"),
  }),
}).required();

export const updateUser = Joi.object({
  body: Joi.object({
    firstName: Joi.string().optional(),
    lastName: Joi.string().optional(),
    middleName: Joi.string().optional(),
    picture: Joi.string().optional(),
    phone: Joi.string().phoneNumber().optional().label("Phone Number"),
  }),
  country: Joi.string().optional(),
}).required();
