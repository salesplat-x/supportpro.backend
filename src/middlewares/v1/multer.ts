import { Request } from "express";
import multer from "multer";

const storage = multer.diskStorage({
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

export const upload = multer({ storage });
