import { IProfile, IUser } from "../../typings/user";
import * as userRepository from "../../repository/v1/user";
import { makeResponse } from "../../helpers/response";
import { replaceAsset } from "../../services/v1/cloudinary";
import { extractText, overlapChunkText, preprocessText } from "../../helpers/func";
import { createEmbedding } from "../../services/v1/openai";
import { saveTalentEmbedding } from "../../repository/v1/pg";

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export const ALLOWED_CV_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export const CV_EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

export const uploadProfileImage = async (user: IUser, file?: Express.Multer.File) => {
  if (!file) {
    return makeResponse(false, "No file uploaded", {}, 400);
  }
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    return makeResponse(false, "Unsupported image type", {}, 400);
  }

  const existingUser = await userRepository.findUserById(user._id);
  if (!existingUser) {
    return makeResponse(false, "Authenticated user no longer exist!", {}, 404);
  }

  const asset = await replaceAsset(existingUser.profileImage?.publicId, file.buffer, {
    folder: "supportpro/profilepicture",
    publicId: `${user._id}-image`,
    mimetype: file.mimetype,
    resourceType: "image",
  });

  const updatedUser = await userRepository.findUserByIdAndUpdate(user._id, {
    profileImage: { url: asset.url, publicId: asset.publicId },
  });

  return makeResponse(true, "Profile image updated successfully", { user: updatedUser });
};

export const uploadCv = async (user: IUser, file?: Express.Multer.File) => {
  if (!file) {
    return makeResponse(false, "No file uploaded", {}, 400);
  }
  if (!ALLOWED_CV_TYPES.includes(file.mimetype)) {
    return makeResponse(false, "Unsupported CV file type", {}, 400);
  }

  const existingUser = await userRepository.findUserById(user._id);
  if (!existingUser?.profile) {
    return makeResponse(false, "Authenticated user has no profile!", {}, 404);
  }
  const profile = existingUser.profile as IProfile;

  let text: string | string[] = await extractText(file.buffer, file.mimetype);
  if (!text) {
    return makeResponse(false, "Unable to extract text from CV", {}, 400);
  }
  text = overlapChunkText(preprocessText(text));

  const cvEmbedding = await createEmbedding(text);
  const embeddingRes = await saveTalentEmbedding(user._id.toString(), text, cvEmbedding);
  if (!embeddingRes) {
    return makeResponse(false, "Unable to save CV embedding", {}, 500);
  }

  const asset = await replaceAsset(profile.cv?.publicId, file.buffer, {
    folder: "supportpro/cvs",
    publicId: `${user._id}-cv`,
    mimetype: file.mimetype,
    format: CV_EXT_BY_MIME[file.mimetype],
    resourceType: "auto",
  });

  const updatedProfile = await userRepository.findProfileByIdAndUpdate(profile._id, {
    cv: { url: asset.url, publicId: asset.publicId, uploadedAt: new Date() },
  });

  return makeResponse(true, "CV uploaded successfully", { profile: updatedProfile });
};
