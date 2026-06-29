import { Request } from "express";
import multer from "multer";

const diskStorage = multer.diskStorage({
  destination: (_req: Request, _file, cb) => {
    cb(null, "uploads/");
  },
  filename: (_req, file, cb) => {
    const parts = file.originalname.split(".");
    const base = parts.length > 1 ? parts.slice(0, -1).join("_") : file.originalname;
    const newName = base.replace(/ /g, "-") + "_" + Date.now().toString() + "." + parts.pop();
    file.filename = newName;
    cb(null, newName);
  },
});

export const diskUpload = multer({ storage: diskStorage, limits: { fileSize: 10 * 1024 * 1024 } });
export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
