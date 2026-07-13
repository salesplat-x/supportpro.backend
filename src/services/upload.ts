import { ValidationError } from "../utils/errors";
import { handleUpload } from "../utils/integrations/cloudinary.js";
import { handleFilename } from "../utils/text.js";

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const ALLOWED_CV_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const CLOUDINARY_FOLDERS = {
  images: "salesplate/images",
  cv: "salesplate/cv",
} as const;

export const uploadCloudinary = async (
  file?: Express.Multer.File
): Promise<{ fileUrl: string }> => {
  if (!file) {
    throw new ValidationError("No file uploaded");
  }

  let folder: string;
  if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    folder = CLOUDINARY_FOLDERS.images;
  } else if (ALLOWED_CV_TYPES.includes(file.mimetype)) {
    folder = CLOUDINARY_FOLDERS.cv;
  } else {
    throw new ValidationError("Unsupported file type");
  }

  const { name, ext } = handleFilename(file.originalname);
  const fileBuffer = file.buffer;
  const b64 = fileBuffer.toString("base64");
  const dataURI = "data:" + file.mimetype + ";base64," + b64;

  const cldRes = await handleUpload(dataURI, name, ext, folder);
  return { fileUrl: cldRes.secure_url };
};
