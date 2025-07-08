import { Application, Router } from "express";
import v1 from "../routes/v1";

export default function versionRoutes(app: Application): void {
  const router = Router();

  v1(router);

  // Hybrid route mounting (This was just done to avoid "page not found" error)
  app.use("/v1", router);
  app.use("/", router); 

}

