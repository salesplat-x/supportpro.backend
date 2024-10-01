import { Response, Request } from "express";
import * as messageController from "../../logics/v1/message";
import { responseHandler } from "../../middlewares/v1/handler";

export const create = async (req: Request, res: Response) => {
  const response = await messageController.sendMessage(req.user, req.body);
  return responseHandler(res, response);
};

export const broadcastMessage = async (req: Request, res: Response) => {
  const response = await messageController.broadcastMessage(req.user, req.body);
  return responseHandler(res, response);
};

export const getMessages = async (req: Request, res: Response) => {
  const response = await messageController.getMessages(req.user, {
    ...req.query,
    ...req.body,
  });
  return responseHandler(res, response);
};

export const getMessage = async (req: Request, res: Response) => {
  const response = await messageController.getMessage(req.user, req.params.id!);
  return responseHandler(res, response);
};

// export const deleteMessage = async (req: Request, res: Response) => {
//   const response = await messageController.deleteMessage(
//     req.user,
//     req.params.id!
//   );
//   return responseHandler(res, response);
// };
