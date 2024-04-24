import * as roleRepository from "../../repository/v1/role";
import { makeResponse } from "../../helpers/response";
import { IRole } from "../../typings/role";
import { exists } from "fs";

export const createRole = async (payload: IRole) => {
  //@TODO check if role exists
  payload.name = payload.name.toLowerCase();
  const existingRole = await roleRepository.findRoleByMatch({
    name: payload.name,
  });
  if (existingRole) {
    return makeResponse(false, "Role already exists", {}, 409);
  }
  let role = await roleRepository.createRole(payload);
  return makeResponse(true, "Role posted successfully", role, 200);
};

export const fetchAllRoles = async () => {
  let roles = await roleRepository.findAllRoles();
  return makeResponse(true, "Roles fetched successfully", roles, 200);
};

export const fetchRole = async (payload: Pick<IRole, "_id">) => {
  let role = await roleRepository.findRoleById(payload._id);
  if (!role) {
    return makeResponse(false, "Role not found", {}, 404);
  }
  return makeResponse(true, "Role fetched successfully", role, 200);
};
