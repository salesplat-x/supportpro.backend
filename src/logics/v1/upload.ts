import { makeResponse } from "../../helpers/response";
import { Request } from "express";
import { handleUpload } from "../../services/v1/cloudinary";
import {
  chunkText,
  extractText,
  handleFilename,
  overlapChunkText,
  preprocessText,
} from "../../helpers/func";
import { createEmbedding } from "../../services/v1/openai";
import { saveTalentEmbedding } from "../../repository/v1/pg";
import { IProfile } from "../../typings/user";
import { Roles } from "../../typings/customs";

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

  if (req.user.userRole === Roles.Talent) {
    // extract text from CV
    const mimetype = req.file.mimetype;
    if (
      mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mimetype === "application/msword" ||
      mimetype === "application/pdf"
    ) {
      let text: string | string[] = await extractText(req.file.buffer, mimetype);
      if (!text) {
        return makeResponse(false, "Unable to extract text");
      }
      text = preprocessText(text);
      text = overlapChunkText(text);

      // Create vector embedding for the chunks
      const cvEmbedding = await createEmbedding(text);

      const res = await saveTalentEmbedding(
        // (req.user.profile as IProfile)._id.toString(),
        req.user._id.toString(),
        text,
        cvEmbedding
      );
      if (!res) {
        return makeResponse(false, "Unable to save cv embedding", {}, 500);
      }
    }
  }

  const { name, ext } = handleFilename(req.file.originalname);
  const fileBuffer = req.file.buffer as Buffer;
  const b64 = fileBuffer.toString("base64");

  const dataURI = "data:" + req.file.mimetype + ";base64," + b64;

  const cldRes = await handleUpload(dataURI, name, ext);
  return makeResponse(true, "File uploaded", { fileUrl: cldRes.secure_url });
};
