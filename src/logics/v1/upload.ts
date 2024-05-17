import { makeResponse } from "../../helpers/response";
import { Request } from "express";
import { handleUpload } from "../../servces/v1/cloudinary";
import { handleFilename } from "../../helpers/func";

export const uploadLocal = async (req: Request) => {
  if (!req.file) {
    return makeResponse(false, "No file uploaded");
  }
  const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${
    req.file.filename
  }`;
  return makeResponse(true, "File uploaded", { fileUrl });
};

export const uploadCloudinary = async (req: Request) => {
  if (!req.file) {
    return makeResponse(false, "No file uploaded");
  }

  const { name, ext } = handleFilename(req.file.originalname);
  const b64 = Buffer.from(req.file.buffer).toString("base64");
  let dataURI = "data:" + req.file.mimetype + ";base64," + b64;

  const cldRes = await handleUpload(dataURI, name, ext);
  return makeResponse(true, "File uploaded", { fileUrl: cldRes.secure_url });
};
