export const SEED_PASSWORD = "qaz!1234";
export const TALENT_EMAIL_DOMAIN = "seed.test";
export const COMPANY_DOMAIN_PREFIX = "seedco";
export const COMPANY_DOMAIN_SUFFIX = "test";
export const RECRUITERS_PER_COMPANY = 5;
export const APPLICATIONS_PER_TALENT = 6;
export const EMBEDDING_DIMENSIONS = 512;

export const SEED_TALENT_EMAIL_LIKE = "%@seed.test";
export const SEED_RECRUITER_EMAIL_LIKE = "%@seedco-%.test";
export const SEED_ORG_DOMAIN_LIKE = "seedco-%.test";

export type SeedScale = {
  n: number;
  talents: number;
  jobs: number;
  companies: number;
  recruitersPerCompany: number;
  recruiters: number;
};

export function computeScale(n: number): SeedScale {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("Scale factor N must be a positive integer.");
  }
  const companies = Math.max(1, Math.floor(n / 2));
  return {
    n,
    talents: n * 4,
    jobs: n * 10,
    companies,
    recruitersPerCompany: RECRUITERS_PER_COMPANY,
    recruiters: companies * RECRUITERS_PER_COMPANY,
  };
}

export function padNumber(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function orgDomain(companyIndex: number): string {
  return `${COMPANY_DOMAIN_PREFIX}-${padNumber(companyIndex, 2)}.${COMPANY_DOMAIN_SUFFIX}`;
}

export function talentEmail(index: number): string {
  return `talent-${padNumber(index, 3)}@${TALENT_EMAIL_DOMAIN}`;
}

export function recruiterEmail(companyIndex: number, recruiterIndex: number): string {
  return `r${padNumber(recruiterIndex, 2)}@${orgDomain(companyIndex)}`;
}

export function pendingInviteEmail(companyIndex: number): string {
  return `invite@${orgDomain(companyIndex)}`;
}

export function isSeedUserEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return lower.endsWith(`@${TALENT_EMAIL_DOMAIN}`) || /@seedco-\d+\.test$/.test(lower);
}

export function isSeedOrgDomain(domain: string): boolean {
  return /^seedco-\d+\.test$/.test(domain.toLowerCase());
}

export function catalogItem<T>(items: readonly T[], index: number): T {
  if (items.length === 0) {
    throw new Error("Seed catalog is empty");
  }
  return items[index % items.length] as T;
}

export const STUB_EMBEDDING = `[${Array.from({ length: EMBEDDING_DIMENSIONS }, () => "0.1").join(",")}]`;

export const ROLE_CATALOG: ReadonlyArray<{ name: string; description: string }> = [
  { name: "Software Engineer", description: "Designs and builds software systems." },
  { name: "Frontend Engineer", description: "Builds user-facing web applications." },
  { name: "Backend Engineer", description: "Designs APIs, services, and data stores." },
  { name: "Full Stack Engineer", description: "Works across frontend and backend." },
  { name: "DevOps Engineer", description: "Owns CI/CD, cloud, and reliability." },
  { name: "Data Analyst", description: "Turns product and business data into insight." },
  { name: "Data Scientist", description: "Builds models and statistical analyses." },
  { name: "Product Manager", description: "Defines product strategy and delivery." },
  { name: "Product Designer", description: "Owns UX, UI, and product visual systems." },
  { name: "UI/UX Designer", description: "Designs usable, accessible interfaces." },
  { name: "QA Engineer", description: "Builds test strategy and quality gates." },
  { name: "Mobile Engineer", description: "Builds iOS and Android applications." },
  { name: "Engineering Manager", description: "Leads engineering teams and delivery." },
  { name: "Customer Success Manager", description: "Owns customer outcomes after sale." },
  { name: "Sales Manager", description: "Leads pipeline, forecasting, and close." },
  { name: "Marketing Manager", description: "Owns campaigns, growth, and brand." },
  { name: "People Operations Manager", description: "Runs hiring operations and people programs." },
  { name: "Operations Manager", description: "Improves processes and operational cadence." },
  { name: "Finance Analyst", description: "Supports planning, reporting, and controls." },
  { name: "Technical Writer", description: "Writes product and engineering documentation." },
];

export const FIRST_NAMES = [
  "Ada",
  "Chidi",
  "Amara",
  "Tunde",
  "Zainab",
  "Ifeoma",
  "Kwame",
  "Nia",
  "Omar",
  "Sade",
  "Yusuf",
  "Lila",
  "Emeka",
  "Amina",
  "Kofi",
  "Bola",
] as const;

export const LAST_NAMES = [
  "Okafor",
  "Adeyemi",
  "Mensah",
  "Nwosu",
  "Balogun",
  "Diallo",
  "Okoro",
  "Adebayo",
  "Hassan",
  "Ibrahim",
  "Chukwu",
  "Bello",
  "Osei",
  "Lawal",
  "Nkrumah",
  "Eze",
] as const;

export const CITIES: ReadonlyArray<{ city: string; state: string; country: string }> = [
  { city: "Lagos", state: "Lagos", country: "Nigeria" },
  { city: "Abuja", state: "FCT", country: "Nigeria" },
  { city: "Accra", state: "Greater Accra", country: "Ghana" },
  { city: "Nairobi", state: "Nairobi", country: "Kenya" },
  { city: "Kigali", state: "Kigali", country: "Rwanda" },
  { city: "Cape Town", state: "Western Cape", country: "South Africa" },
  { city: "London", state: "England", country: "United Kingdom" },
  { city: "Austin", state: "Texas", country: "United States" },
];

export const INDUSTRIES = [
  "Technology",
  "Financial Services",
  "Healthcare",
  "Education",
  "Logistics",
  "Retail",
  "Energy",
  "Media",
] as const;

export const SKILLS = [
  "TypeScript",
  "React",
  "Node.js",
  "PostgreSQL",
  "Python",
  "Product strategy",
  "User research",
  "SQL",
  "AWS",
  "Figma",
  "Stakeholder management",
  "System design",
] as const;

export const GOALS = [
  "Ship a reliable hiring pipeline in the first 90 days",
  "Raise candidate quality without slowing time-to-hire",
  "Build a repeatable screening bar for this role",
  "Improve recruiter and hiring-manager collaboration",
] as const;

export const MBTI_TYPES = [
  "INTJ",
  "INTP",
  "ENTJ",
  "ENTP",
  "INFJ",
  "INFP",
  "ENFJ",
  "ENFP",
  "ISTJ",
  "ISFJ",
  "ESTJ",
  "ESFJ",
  "ISTP",
  "ISFP",
  "ESTP",
  "ESFP",
] as const;

export const DEFAULT_SCREENING_STAGES: Record<string, string> = {
  prescreening: "cv_similarity",
  cv_similarity: "personalized",
  personalized: "personality",
  personality: "completed",
};
