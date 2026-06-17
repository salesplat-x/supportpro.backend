import { Router } from "express";
import * as prescreening from "../../controllers/v1/prescreening";
import { asyncHandler } from "../../middlewares/v1/handler";
import { validateAccess } from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

const router = Router();

router.get("/", validateAccess([Roles.Talent]), asyncHandler(prescreening.getPreScreening));

router.post("/submit", validateAccess([Roles.Talent]), asyncHandler(prescreening.submitAnswers));

router.post("/retake", validateAccess([Roles.Talent]), asyncHandler(prescreening.requestRetake));

export default (app: Router) => app.use("/prescreening", router);
