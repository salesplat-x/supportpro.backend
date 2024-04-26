import { Router } from "express";
import * as uploadHandler from "../../controllers/v1/upload";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired } from "../../middlewares/v1/auth";
import multer from "multer";
import { storage } from "../../middlewares/v1/multer";

const router = Router();
// const upload = multer({ dest: "uploads/"});
const upload = multer({ storage });

router.post(
  "/",
  loginRequired,
  upload.single("file"),
  asyncHandler(uploadHandler.uploadFile)
);

export default (app: Router) => app.use("/uploads", router);
