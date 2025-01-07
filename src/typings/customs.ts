export const Roles = {
  Admin: "admin",
  Superadmin: "superadmin",
  Talent: "talent",
  Recruiter: "recruiter",
} as const;

export const ExperienceLevel = {
  oneToThreeYears: "1-3 years",
  fourToSixYears: "4-6 years",
  sevenToTenYears: "7-10 years",
  elevenToFifteenYears: "11-15 years",
  sixteenYearsAndAbove: "16 years and above",
} as const;
export type TExperienceLevel =
  (typeof ExperienceLevel)[keyof typeof ExperienceLevel];

export const Plan = {
  Basic: "basic",
  Business: "business",
  Enterprise: "enterprise",
} as const;

export const Objective = {
  Manage: "manage talents",
  Hire: "hire talents",
  Find: "find talents",
} as const;

export const CurrentHiringProcess = {
  Website: "website",
  Linkedin: "linkedin",
  Outsourced: "outsourced",
} as const;

export const Page = {
  Limit: 20,
  Offset: 0,
  Sort: -1,
} as const;

export interface Paging {
  limit?: number;
  offset?: number;
  sort?: string;
  sortMethod?: Record<string, any>;
}

export interface MakeResponse<T = Record<string, any>> {
  status: boolean;
  message: string;
  data?: T;
  statusCode?: number;
}
export interface ILocation {
  city: string;
  state: string;
  country: string;
}
