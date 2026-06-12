import express, { Application } from "express";
import logger from "./config/logger";
import env from "./config/env";
import versionRoutes from "./version/v1";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import swaggerDocs from "./swagger";
import { generalLimiter } from "./middlewares/v1/rateLimiter";
import { sendSuccessResponse } from "./helpers/response";

export default function createApp(): Application {
  const app: Application = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.raw());
  app.use(cors({ origin: env.website }));
  app.use(
    helmet({
      frameguard: {
        action: "deny", // change to 'sameorigin' if you want to allow iframes
      },
    })
  );

  app.get("/", (req, res) => {
    sendSuccessResponse(res, "Welcome to Support Pro Backend");
  });

  swaggerDocs(app, env.port);

  // Serve uploaded files statically
  app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

  // enable logging
  app.use(logger.logan);
  app.use(generalLimiter);
  versionRoutes(app);

  return app;
}
