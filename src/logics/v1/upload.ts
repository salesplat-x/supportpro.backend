import { makeResponse } from "../../helpers/response";
import { Request } from "express";
import { handleUpload } from "../../services/v1/cloudinary";
import { handleFilename } from "../../helpers/func";
import { ALLOWED_CV_TYPES, ALLOWED_IMAGE_TYPES, CLOUDINARY_FOLDERS } from "../../helpers/uploads";

export const uploadLocal = async (req: Request) => {
  if (!req.file) {
    return makeResponse(false, "No file uploaded");
  }
  const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
  return makeResponse(true, "File uploaded", { fileUrl });
};

// Logic to upload to cloudinary
export const uploadCloudinary = async (req: Request) => {
  if (!req.file) {
    return makeResponse(false, "No file uploaded");
  }

  let folder: string;
  if (ALLOWED_IMAGE_TYPES.includes(req.file.mimetype)) {
    folder = CLOUDINARY_FOLDERS.images;
  } else if (ALLOWED_CV_TYPES.includes(req.file.mimetype)) {
    folder = CLOUDINARY_FOLDERS.cv;
  } else {
    return makeResponse(false, "Unsupported file type", {}, 400);
  }

  const { name, ext } = handleFilename(req.file.originalname);
  const fileBuffer = req.file.buffer as Buffer;
  const b64 = fileBuffer.toString("base64");

  const dataURI = "data:" + req.file.mimetype + ";base64," + b64;

  const cldRes = await handleUpload(dataURI, name, ext, folder);
  return makeResponse(true, "File uploaded", { fileUrl: cldRes.secure_url });
};
