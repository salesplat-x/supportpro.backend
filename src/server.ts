import "dotenv/config";
import logger from "./config/logger";
import env from "./config/env";
import express, { Application } from "express";
import { newMongoDBConnection } from "./config/db";
import versionRoutes from "./version/v1";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { setupPostgresDB } from "./repository/v1/pg";
import swaggerDocs from "./swagger";

const PORT = env.port;

export default async function startApplication(app: Application): Promise<void> {
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.raw());
  // @TODO restrict origin
  app.use(cors());
  app.use(
    helmet({
      frameguard: {
        action: "deny", // change to 'sameorigin' if you want to allow iframes
      },
    })
  );

  swaggerDocs(app, PORT)

  // Serve uploaded files statically
  app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

  // enable logging
  app.use(logger.logan);
  versionRoutes(app);

  // connect to mongodb via mongoose
  await newMongoDBConnection();

  // setup PostgresDB
  await setupPostgresDB();

  app.listen(PORT, async () => {
    logger.log(`All connections established successfully 🚀`);
    logger.log(`App is listening on http://localhost:${PORT}`);
  });
}
