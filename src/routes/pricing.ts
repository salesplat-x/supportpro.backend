import { Router } from "express";
import * as pricing from "../controllers/pricing.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

const router = Router();

router.get("/", asyncHandler(pricing.getPricingCatalog));

export default (app: Router) => app.use("/pricing", router);
