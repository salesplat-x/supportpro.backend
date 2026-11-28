import { AppDataSource } from "../database/dataSource.js";
import { UserRole } from "../types/enums.js";
import { AuthorizationError, ValidationError } from "../utils/errors";

// The active company counts only while the user still owns it or is on its team.
export const getActiveOrganizationId = async (userId: string): Promise<string | null> => {
  const [row]: Array<{ id: string }> = await AppDataSource.query(
    `SELECT u."active_organization_id" AS "id"
     FROM "users" u
     JOIN "organizations" o ON o."id" = u."active_organization_id"
     WHERE u."id" = $1
       AND (o."owner_id" = u."id" OR EXISTS (
         SELECT 1 FROM "organization_members" m
         WHERE m."user_id" = u."id" AND m."organization_id" = o."id"
       ))`,
    [userId]
  );
  return row?.id ?? null;
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
