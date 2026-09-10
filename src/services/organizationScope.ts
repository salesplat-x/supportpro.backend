import { AppDataSource } from "../database/dataSource.js";
import { User } from "../entities/User.js";
import { UserRole } from "../types/enums.js";
import { AuthorizationError, ValidationError } from "../utils/errors";

const userRepo = () => AppDataSource.getRepository(User);

export const getActiveOrganizationId = async (userId: string): Promise<string | null> => {
  const user = await userRepo().findOne({
    where: { id: userId },
    select: { id: true, activeOrganizationId: true },
  });
  return user?.activeOrganizationId ?? null;
};

export const requireActiveOrganizationId = async (
  userId: string,
  message = "Create or switch to a company first"
): Promise<string> => {
  const activeOrganizationId = await getActiveOrganizationId(userId);
  if (!activeOrganizationId) {
    throw new ValidationError(message);
  }
  return activeOrganizationId;
};

/**
 * Company-owned recruiter resources are visible/editable only while that
 * company is the caller's active workspace. Rows that predate tenancy
 * (no organizationId) stay owned by the original poster.
 */
export const assertCompanyResourceAccess = async (
  userId: string,
  userRole: UserRole,
  organizationId: string | null | undefined,
  ownerUserId?: string | null
): Promise<void> => {
  if (userRole === UserRole.Admin) return;

  if (organizationId) {
    const activeOrganizationId = await getActiveOrganizationId(userId);
    if (activeOrganizationId === organizationId) return;
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  if (ownerUserId && ownerUserId === userId) return;

  throw new AuthorizationError("You are not authorized to perform this action");
};
