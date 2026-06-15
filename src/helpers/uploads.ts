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

export const CLOUDINARY_FOLDERS = {
  images: "salesplate/images",
  cv: "salesplate/cv",
} as const;
