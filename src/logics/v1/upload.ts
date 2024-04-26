import { IProfile, IUser } from "../../typings/user";
import * as userRepository from "../../repository/v1/user";
import * as roleRepository from "../../repository/v1/role";
import { makeResponse } from "../../helpers/response";
import { Request } from "express";

export const uploadFile = async (req: Request) => {
  try {
    if (!req.file) {
      return makeResponse(false, "No file uploaded");
    }
    console.log(req.file);
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${
      req.file.filename
    }`;
    return makeResponse(true, "File uploaded", { fileUrl });
  } catch (error) {
    console.error(error);
    return makeResponse(false, "Error uploading file");
  }
};
