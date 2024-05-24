import { makeResponse } from "../../helpers/response";
import { Request } from "express";
import { handleUpload } from "../../servces/v1/cloudinary";
import {
  chunkText,
  extractText,
  handleFilename,
  preprocessText,
} from "../../helpers/func";
import { createEmbedding } from "../../servces/v1/openai";

export const uploadLocal = async (req: Request) => {
  if (!req.file) {
    return makeResponse(false, "No file uploaded");
  }
  const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${
    req.file.filename
  }`;
  return makeResponse(true, "File uploaded", { fileUrl });
};

// Logic to upload to cloudinary
export const uploadCloudinary = async (req: Request) => {
  if (!req.file) {
    return makeResponse(false, "No file uploaded");
  }

  // extract text from CV
  const mimetype = req.file.mimetype;
  if (
    mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimetype === "application/msword" ||
    mimetype === "application/pdf"
  ) {
    let text: string | string[] = await extractText(req.file.buffer, mimetype);
    if (!text) {
      return makeResponse(false, "Unable to extract text");
    }
    text = preprocessText(text);
    text = chunkText(text);

    // Create vector embedding for the chunks
    const cvEmbedding = await createEmbedding(text);

    // @TODO save cvEmbedding[0]?.embedding to vectorDB
  }

  const { name, ext } = handleFilename(req.file.originalname);
  const b64 = Buffer.from(req.file.buffer).toString("base64");
  let dataURI = "data:" + req.file.mimetype + ";base64," + b64;

  const cldRes = await handleUpload(dataURI, name, ext);
  return makeResponse(true, "File uploaded", { fileUrl: cldRes.secure_url });
};
