import { v2 as cloudinary } from "cloudinary";
import env from "../../config/env";

cloudinary.config({
  cloud_name: env.cloudinary_name,
  api_key: env.cloudinary_key,
  api_secret: env.cloudinary_secret,
});

export const handleUpload = async (file: string, name: string, format?: string) => {
  if (format === "doc" || format === "docx") {
    name = name.concat(".", format);
  }
  return await cloudinary.uploader.upload(file, {
    use_filename: true,
    resource_type: "auto",
    format,
    public_id: name,
  });
};
