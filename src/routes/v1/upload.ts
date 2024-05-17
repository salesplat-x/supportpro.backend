import { Router } from "express";
import * as uploadHandler from "../../controllers/v1/upload";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired } from "../../middlewares/v1/auth";
import { cloudinaryUpload, diskUpload } from "../../middlewares/v1/multer";

const router = Router();
// const upload = multer({ dest: "uploads/"});

router.post(
  "/",
  loginRequired,
  cloudinaryUpload.single("file"),
  asyncHandler(uploadHandler.uploadCloudinary)
);

router.post(
  "/local",
  loginRequired,
  diskUpload.single("file"),
  asyncHandler(uploadHandler.uploadLocal)
);

export default (app: Router) => app.use("/uploads", router);
