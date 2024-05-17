import { Request } from "express";
import multer from "multer";

const diskStorage = multer.diskStorage({
  destination: (req: Request, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const oldName =
      file.originalname.split(".") && file.originalname.split(".").length
        ? file.originalname
            .split(".")
            .slice(0, file.originalname.split(".").length - 1)
            .join("_")
        : file.originalname;
    const newName =
      oldName.replace(/ /g, "-") +
      "_" +
      Date.now().toString() +
      "." +
      file.originalname.split(".").pop();
    file.filename = newName;

    cb(null, newName);
  },
});

const memoryStorage = multer.memoryStorage();

export const diskUpload = multer({ storage: diskStorage });
export const cloudinaryUpload = multer({ storage: memoryStorage });
