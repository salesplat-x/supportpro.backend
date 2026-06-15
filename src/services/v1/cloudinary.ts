import { v2 as cloudinary } from "cloudinary";
import env from "../../config/env";

cloudinary.config({
  cloud_name: env.cloudinary_name,
  api_key: env.cloudinary_key,
  api_secret: env.cloudinary_secret,
});

export const handleUpload = async (
  file: string,
  name: string,
  format?: string,
  folder?: string
) => {
  if (format === "doc" || format === "docx") {
    name = name.concat(".", format);
  }
  return await cloudinary.uploader.upload(file, {
    use_filename: true,
    resource_type: "auto",
    format,
    public_id: name,
    folder,
  });
};

export interface CloudAsset {
  url: string;
  publicId: string;
}

export interface UploadAssetOptions {
  folder: string;
  publicId: string;
  mimetype: string;
  format?: string;
  resourceType?: "image" | "raw" | "auto";
}

export const uploadBuffer = async (
  buffer: Buffer,
  options: UploadAssetOptions
): Promise<CloudAsset> => {
  const base64 = buffer.toString("base64");
  const dataURI = `data:${options.mimetype};base64,${base64}`;
  const res = await cloudinary.uploader.upload(dataURI, {
    resource_type: options.resourceType ?? "auto",
    overwrite: true,
    folder: options.folder,
    public_id: options.publicId,
    format: options.format,
  });
  return { url: res.secure_url, publicId: res.public_id };
};

// Derives the Cloudinary public_id (including folder) from a secure_url, e.g.
// https://res.cloudinary.com/<cloud>/image/upload/v123/salesplate/images/foo.png -> salesplate/images/foo
export const extractPublicIdFromUrl = (url: string): string | undefined => {
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/);
  return match?.[1];
};

export const destroyAsset = async (
  publicId: string,
  resourceType: "image" | "raw" | "auto" = "auto"
) => {
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
};

export const replaceAsset = async (
  oldPublicId: string | undefined,
  buffer: Buffer,
  options: UploadAssetOptions
): Promise<CloudAsset> => {
  if (oldPublicId) {
    await destroyAsset(oldPublicId, options.resourceType ?? "auto");
  }
  return uploadBuffer(buffer, options);
};
