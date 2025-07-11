import { Response, Request } from "express";
import * as logic from "../../logics/v1/subscription";
import { responseHandler } from "../../middlewares/v1/handler";

export const fetch = async (req: Request, res: Response) => {
    const response = await logic.fetch();
    return responseHandler(res, response);
};

export const fetchOne = async (req: Request, res: Response) => {
    const response = await logic.fetchOne(req.params.id as string);
    return responseHandler(res, response);
};

export const fetchByMatch = async (req: Request, res: Response) => {
    const response = await logic.fetchByMatch(req.body);
    return responseHandler(res, response);
};
export const enable = async (req: Request, res: Response) => {
    const response = await logic.enable(req.params.id as string);
    return responseHandler(res, response);
};

export const disable = async (req: Request, res: Response) => {
    const response = await logic.disable(req.params.id as string);
    return responseHandler(res, response);
};