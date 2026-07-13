import "reflect-metadata";
import "dotenv/config";
import express, { Application } from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import env from "./config/env.js";
import logger, { httpLogger } from "./utils/logger.js";
import { generalLimiter } from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { sendSuccessResponse } from "./utils/response.js";
import { AppDataSource, initializeDatabase } from "./database/dataSource.js";
import v1Router from "./routes/index.js";
import swaggerDocs from "./swagger.js";
import { reconcilePendingCvEmbeddings } from "./services/reconciliation.js";

export function createApp(): Application {
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || env.allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`Not allowed by CORS: ${origin}`));
        }
      },
      credentials: true,
    })
  );
  app.use(helmet({ frameguard: { action: "deny" } }));
  app.use(httpLogger);
  app.use(generalLimiter);

  app.get("/", (_req, res) => sendSuccessResponse(res, "Welcome to SupportPro Backend"));
  app.get("/health", async (_req, res) => {
    try {
      await AppDataSource.query("SELECT 1");
      res.json({ status: "ok", db: "connected", timestamp: new Date().toISOString() });
    } catch {
      res
        .status(503)
        .json({ status: "error", db: "disconnected", timestamp: new Date().toISOString() });
    }
  });
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

  swaggerDocs(app, env.port);

  app.use("/v1", v1Router);

  // Global error handler — must be last
  app.use(errorHandler);

  return app;
}

async function startApplication(): Promise<void> {
  await initializeDatabase();
  logger.info("Database connected successfully");

  const app = createApp();
  const PORT = env.port || 3000;

  const server = app.listen(PORT, () => {
    logger.info(`App listening on http://localhost:${PORT}`);
  });

  // Self-healing sweep for CV embeddings left orphaned by a failed or interrupted
  // fire-and-forget generation (see services/reconciliation.ts). Runs in-process —
  // no separate worker/queue — so it only needs the Postgres connection we already have.
  const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
  const reconcileInterval = setInterval(() => {
    reconcilePendingCvEmbeddings().catch((err: Error) =>
      logger.error(`CV embedding reconciliation sweep failed: ${err.message}`)
    );
  }, RECONCILE_INTERVAL_MS);
  reconcileInterval.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received — shutting down gracefully`);
    clearInterval(reconcileInterval);
    server.close(async () => {
      await AppDataSource.destroy().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, 30_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Do not auto-start when imported by tests (Jest sets NODE_ENV=test).
if (process.env.NODE_ENV !== "test") {
  startApplication().catch((err: Error) => {
    logger.error("Failed to start application", { message: err.message, stack: err.stack });
    process.exit(1);
  });
}
