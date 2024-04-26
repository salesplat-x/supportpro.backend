import { Router } from "express";
import * as uploadHandler from "../../controllers/v1/upload";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired } from "../../middlewares/v1/auth";
import { upload } from "../../middlewares/v1/multer";

const router = Router();
// const upload = multer({ dest: "uploads/"});

router.post(
  "/",
  loginRequired,
  upload.single("file"),
  asyncHandler(uploadHandler.uploadFile)
);

export default (app: Router) => app.use("/uploads", router);
