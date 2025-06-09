import { Response, Request } from "express";
import * as logic from "../../logics/v1/plan";
import { responseHandler } from "../../middlewares/v1/handler";

export const create = async (req: Request, res: Response)=> {
    const response = await logic.create(req.body);
    return responseHandler(res, response);
}

export const fetch = async (req: Request, res: Response) => {
    const response = await logic.fetch();
    return responseHandler(res, response);
};

export const fetchOne = async (req: Request, res: Response) => {
    const response = await logic.fetchOne(req.params.id as string);
    return responseHandler(res, response);
};

export const update = async (req: Request, res: Response) => {
    const response = await logic.update(req.params._id as string, req.body);
    return responseHandler(res, response);
};

export const deleteItem = async (req: Request, res: Response) => {
    const response = await logic.deleteItem(req.params.id as string);
    return responseHandler(res, response);
};