import { Request } from "express";
import multer from "multer";

export const storage = multer.diskStorage({
  destination: (req: Request, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const fileName =
      Date.now().toString() + `${file.originalname.replace(/ /g, "-")}-`;
    cb(null, fileName);
  },
});
