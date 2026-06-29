import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { ConflictError, ValidationError } from "../utils/errors/index.js";

const orgRepo = () => AppDataSource.getRepository(Organization);

const validateEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export interface OrganizationPayload {
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  industry?: string | null;
  website?: string | null;
  facebook?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
}

export const createOrganization = async (payload: OrganizationPayload): Promise<Organization> => {
  if (!payload.email) {
    throw new ValidationError("Email is required");
  }
  if (!validateEmail(payload.email)) {
    throw new ValidationError("Invalid Email Address");
  }
  const email = payload.email.toLowerCase();

  const emailExists = await orgRepo().findOne({ where: { email } });
  if (emailExists) {
    throw new ConflictError("Organization already registered with this email");
  }

  if (payload.phone) {
    const phoneExists = await orgRepo().findOne({ where: { phone: payload.phone } });
    if (phoneExists) {
      throw new ConflictError("Organization already registered with this phone number");
    }
  }

  const org = orgRepo().create({ ...payload, email });
  return orgRepo().save(org);
};
