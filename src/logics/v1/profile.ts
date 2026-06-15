import { IUser } from "../../typings/user";
import * as userRepository from "../../repository/v1/user";
import { makeResponse } from "../../helpers/response";
import { replaceAsset } from "../../services/v1/cloudinary";
import { ALLOWED_IMAGE_TYPES, CLOUDINARY_FOLDERS } from "../../helpers/uploads";

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
    folder: CLOUDINARY_FOLDERS.images,
    publicId: `${user._id}-image`,
    mimetype: file.mimetype,
    resourceType: "image",
  });

  const updatedUser = await userRepository.findUserByIdAndUpdate(user._id, {
    profileImage: { url: asset.url, publicId: asset.publicId },
  });

  return makeResponse(true, "Profile image updated successfully", { user: updatedUser });
};
