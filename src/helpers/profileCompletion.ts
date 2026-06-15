import { IProfile } from "../typings/user";

export interface ProfileCompletionCheck {
  key: string;
  check: (profile: IProfile) => boolean;
}

export const PROFILE_COMPLETION_FIELDS: ProfileCompletionCheck[] = [
  { key: "bio", check: (p) => !!p.bio },
  { key: "cv", check: (p) => !!p.cv?.url },
  { key: "role", check: (p) => Array.isArray(p.role) && p.role.length > 0 },
  { key: "location", check: (p) => !!p.location?.country && !!p.location?.state },
  { key: "experience", check: (p) => !!p.experience },
  { key: "salaryRange", check: (p) => p.minSalary != null && p.maxSalary != null },
  { key: "workMode", check: (p) => !!(p.remote || p.onSite || p.hybrid) },
];

export const ONBOARDING_REQUIRED_KEYS = ["cv", "role"];

export const computeProfileCompletionPercentage = (profile: IProfile): number => {
  const passing = PROFILE_COMPLETION_FIELDS.filter(({ check }) => check(profile)).length;
  return Math.round((passing / PROFILE_COMPLETION_FIELDS.length) * 100);
};

export const computeCanProceedToPlatform = (profile: IProfile): boolean => {
  return PROFILE_COMPLETION_FIELDS.filter(({ key }) => ONBOARDING_REQUIRED_KEYS.includes(key)).every(
    ({ check }) => check(profile)
  );
};
