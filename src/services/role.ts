import { EntityManager, QueryFailedError } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Role, Question } from "../entities";
import { NotFoundError, ConflictError } from "../utils/errors";
import { sortDirection } from "../utils/text.js";

// Postgres foreign_key_violation code — thrown when a role still has Jobs
// (or other rows) referencing it.
const FOREIGN_KEY_VIOLATION = "23503";

const roleRepo = () => AppDataSource.getRepository(Role);

const questionRepo = () => AppDataSource.getRepository(Question);

export interface RolePayload {
  name: string;
  description?: string | null;
}

export interface PagingParams {
  limit?: number | string;
  offset?: number | string;
  sort?: string;
}

export const createRole = async (payload: RolePayload): Promise<Role> => {
  const name = payload.name.toLowerCase();
  const existing = await roleRepo().findOne({ where: { name } });
  if (existing) {
    throw new ConflictError("Role already exists");
  }
  const role = roleRepo().create({ name, description: payload.description ?? null });
  return roleRepo().save(role);
};

const cleanRoleName = (name: string): string => name.trim().replace(/\s+/g, " ");

const rolesByKey = async (em: EntityManager, keys: string[]): Promise<Map<string, Role>> => {
  const rows = await em
    .getRepository(Role)
    .createQueryBuilder("role")
    .where("lower(role.name) IN (:...keys)", { keys })
    .orderBy("role.createdAt", "ASC")
    .getMany();
  const found = new Map<string, Role>();
  for (const role of rows) {
    const key = role.name.toLowerCase();
    if (!found.has(key)) found.set(key, role);
  }
  return found;
};

/**
 * Matches typed role names to existing roles regardless of case and creates the missing ones,
 * lowercased like every role created through the API. Two people typing the same new role at
 * once end up with one row.
 */
export const findOrCreateRoles = async (
  names: string[],
  em: EntityManager = AppDataSource.manager
): Promise<Role[]> => {
  const keys = [
    ...new Set(
      names
        .map(cleanRoleName)
        .filter(Boolean)
        .map((n) => n.toLowerCase())
    ),
  ];
  if (keys.length === 0) return [];
  const found = await rolesByKey(em, keys);
  const missing = keys.filter((key) => !found.has(key));
  if (missing.length > 0) {
    await em
      .createQueryBuilder()
      .insert()
      .into(Role)
      .values(missing.map((name) => ({ name })))
      .orIgnore()
      .execute();
    for (const [key, role] of await rolesByKey(em, missing)) found.set(key, role);
  }
  return keys.map((key) => found.get(key)!);
};

export const fetchAllRoles = async (paging: PagingParams): Promise<Role[]> => {
  const limit = Number(paging.limit) || 50;
  const offset = Number(paging.offset) || 0;
  const order = sortDirection(paging.sort ?? "desc");
  return roleRepo().find({
    skip: offset,
    take: limit,
    order: { name: order },
  });
};

export const fetchRole = async (roleId: string): Promise<Role> => {
  const role = await roleRepo().findOne({ where: { id: roleId } });
  if (!role) {
    throw new NotFoundError("Role not found");
  }
  return role;
};

export const updateRole = async (roleId: string, payload: RolePayload): Promise<Role> => {
  const role = await roleRepo().findOne({ where: { id: roleId } });
  if (!role) {
    throw new NotFoundError("Role not found");
  }

  if (payload.name) {
    const name = payload.name.toLowerCase();
    const existing = await roleRepo()
      .createQueryBuilder("role")
      .where("role.name = :name", { name })
      .andWhere("role.id != :id", { id: roleId })
      .getOne();
    if (existing) {
      throw new ConflictError("Role already exists");
    }
    role.name = name;
  }

  if (payload.description !== undefined) {
    role.description = payload.description ?? null;
  }

  return roleRepo().save(role);
};

export const deleteRole = async (roleId: string): Promise<void> => {
  const role = await roleRepo().findOne({ where: { id: roleId } });
  if (!role) {
    throw new NotFoundError("Role not found");
  }

  try {
    await roleRepo().remove(role);
  } catch (err) {
    if (
      err instanceof QueryFailedError &&
      (err as unknown as { code?: string }).code === FOREIGN_KEY_VIOLATION
    ) {
      throw new ConflictError("Role is in use and cannot be deleted");
    }
    throw err;
  }
};

export const fetchRoleQuestions = async (
  roleId: string,
  paging: PagingParams
): Promise<Question[]> => {
  const role = await roleRepo().findOne({ where: { id: roleId } });
  if (!role) {
    throw new NotFoundError("Role not found");
  }
  const limit = Number(paging.limit) || 50;
  const offset = Number(paging.offset) || 0;
  const order = sortDirection(paging.sort ?? "desc");
  return questionRepo().find({
    where: { roleId },
    skip: offset,
    take: limit,
    order: { createdAt: order },
  });
};
