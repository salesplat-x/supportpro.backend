import { Request, Response } from "express";
import * as roleService from "../services/role.js";
import { sendSuccessResponse } from "../utils/response.js";

export const create = async (req: Request, res: Response) => {
  const result = await roleService.createRole(req.body);
  sendSuccessResponse(res, "Role created", { role: result }, 201);
};

export const fetchAll = async (req: Request, res: Response) => {
  const result = await roleService.fetchAllRoles(req.query as Record<string, string>);
  sendSuccessResponse(res, "Roles fetched", { roles: result });
};

export const fetch = async (req: Request, res: Response) => {
  const result = await roleService.fetchRole(req.params["_id"]!);
  sendSuccessResponse(res, "Role fetched", { role: result });
};

export const questions = async (req: Request, res: Response) => {
  const result = await roleService.fetchRoleQuestions(req.params["_id"]!, req.query as Record<string, string>);
  sendSuccessResponse(res, "Questions fetched", { questions: result });
};
