import * as roleRepository from "../../repository/v1/role";
import * as questionRepository from "../../repository/v1/question";
import { makeResponse } from "../../helpers/response";
import { IRole } from "../../typings/role";
import mongoose from "mongoose";
import { Paging } from "../../typings/customs";

export const createRole = async (payload: IRole) => {
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

export const fetchAllRoles = async (payload: Paging) => {
  let roles = await roleRepository.findAllRoles(payload);
  return makeResponse(true, "Roles fetched successfully", roles, 200);
};

export const fetchRole = async (payload: Pick<IRole, "_id">) => {
  if (!mongoose.Types.ObjectId.isValid(payload._id)) {
    return makeResponse(false, "Invalid role id", {}, 400);
  }
  let role = await roleRepository.findRoleById(payload._id);
  if (!role) {
    return makeResponse(false, "Role not found", {}, 404);
  }
  return makeResponse(true, "Role fetched successfully", role, 200);
};

export const questions = async (payload: Pick<IRole, "_id">) => {
  if (!mongoose.Types.ObjectId.isValid(payload._id)) {
    return makeResponse(false, "Invalid role id", {}, 400);
  }
  let role = await roleRepository.findRoleById(payload._id);
  if (!role) {
    return makeResponse(false, "Role not found", {}, 404);
  }
  let questions = await questionRepository.findQuestionByMatch({
    role: payload._id,
  });
  return makeResponse(
    true,
    "Questions fetched successfully",
    questions || [],
    200
  );
};
