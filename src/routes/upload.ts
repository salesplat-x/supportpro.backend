import { Router } from "express";
import * as upload from "../controllers/upload.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired } from "../middleware/auth.js";
import { memoryUpload, diskUpload } from "../middleware/multer.js";

const router = Router();

router.post("/", loginRequired, memoryUpload.single("file"), asyncHandler(upload.uploadCloudinary));
router.post("/local", loginRequired, diskUpload.single("file"), asyncHandler(upload.uploadLocal));

export default (app: Router) => app.use("/uploads", router);
