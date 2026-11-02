import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { extractCompanyProfile } from "../utils/integrations/openai.js";
import logger from "../utils/logger.js";
import { extractText } from "../utils/text.js";
import { ValidationError } from "../utils/errors";
import { assertCanManagePeople } from "./peopleAccess.js";

export interface CompanyProfile {
  mission: string | null;
  vision: string | null;
  yearlyGoals: string[];
}

export const MAX_STATEMENT_LENGTH = 2000;
export const MAX_GOALS = 10;
export const MAX_GOAL_LENGTH = 500;
const MAX_SOURCE_TEXT_LENGTH = 30000;
const DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const profileOf = (org: Organization): CompanyProfile => ({
  mission: org.mission,
  vision: org.vision,
  yearlyGoals: org.yearlyGoals,
});

const cleanStatement = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_STATEMENT_LENGTH) : null;

export const getCompanyProfile = async (
  userId: string,
  organizationId: string
): Promise<CompanyProfile> => profileOf(await assertCanManagePeople(userId, organizationId));

export const saveCompanyProfile = async (
  userId: string,
  organizationId: string,
  profile: CompanyProfile
): Promise<CompanyProfile> => {
  const org = await assertCanManagePeople(userId, organizationId);
  Object.assign(org, profile);
  await AppDataSource.getRepository(Organization).update(organizationId, profile);
  return profileOf(org);
};

export const fillCompanyProfileFromDocument = async (
  userId: string,
  organizationId: string,
  file: Express.Multer.File | undefined
): Promise<CompanyProfile> => {
  await assertCanManagePeople(userId, organizationId);
  if (!file || !DOCUMENT_TYPES.includes(file.mimetype)) {
    throw new ValidationError("Upload a PDF or Word (.docx) file");
  }
  if (file.size === 0) {
    throw new ValidationError("File is empty");
  }

  let text: string;
  try {
    text = await extractText(file.buffer, file.mimetype);
  } catch (err) {
    logger.error(`Company document extraction failed: ${(err as Error).message}`);
    throw new ValidationError("We couldn't read this file. Upload a PDF or Word (.docx) file.");
  }
  if (!text.trim()) {
    throw new ValidationError("We couldn't find any text in this file");
  }

  const reply = await extractCompanyProfile(text.trim().slice(0, MAX_SOURCE_TEXT_LENGTH));
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(reply?.message.content ?? "") as Record<string, unknown>;
  } catch {
    throw new ValidationError("The AI returned an unreadable response. Please try again.");
  }
  const goals = Array.isArray(fields["yearlyGoals"]) ? fields["yearlyGoals"] : [];
  return {
    mission: cleanStatement(fields["mission"]),
    vision: cleanStatement(fields["vision"]),
    yearlyGoals: goals
      .map((goal) => (typeof goal === "string" ? goal.trim().slice(0, MAX_GOAL_LENGTH) : ""))
      .filter(Boolean)
      .slice(0, MAX_GOALS),
  };
};
