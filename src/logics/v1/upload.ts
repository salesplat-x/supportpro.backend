import { makeResponse } from "../../helpers/response";
import { Request } from "express";
import { handleUpload } from "../../servces/v1/cloudinary";

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
  // try {
  if (!req.file) {
    return makeResponse(false, "No file uploaded");
  }

  const b64 = Buffer.from(req.file.buffer).toString("base64");
  let dataURI = "data:" + req.file.mimetype + ";base64," + b64;
  const filename = req.file.originalname;
  const cldRes = await handleUpload(
    dataURI,
    filename.split(".").pop()!,
    filename.split(" ").join("_")
  );
  if (!cldRes) {
    return makeResponse(false, "File upload failed", {}, 400);
  }
  return makeResponse(true, "File uploaded", { fileUrl: cldRes.secure_url });
  // } catch (error) {
  //   console.log(error);
  //   return makeResponse(false, "File uploaded", {}, 500);
  // }
};
