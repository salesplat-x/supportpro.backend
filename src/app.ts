import "reflect-metadata";
import "dotenv/config";
import express, { Application, Request } from "express";
import cors from "cors";
import helmet from "helmet";
import env from "./config/env.js";
import logger, { httpLogger } from "./utils/logger.js";
import { generalLimiter } from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { sendSuccessResponse } from "./utils/response.js";
import { AppDataSource, initializeDatabase } from "./database/dataSource.js";
import v1Router from "./routes";
import swaggerDocs from "./swagger.js";
import { reconcileDurableJobs } from "./services/reconciliation.js";
import { asyncHandler } from "./middleware/asyncHandler.js";
import { companyActivityLogger } from "./middleware/companyActivity.js";
import { SWEEP_INTERVAL_MS } from "./utils/durableJobs.js";
import { isProviderConfigured, loadAiCatalog } from "./utils/integrations/ai/catalog.js";
import { loadAiPrompts } from "./utils/integrations/ai/prompts.js";
import { loadAiSkills } from "./utils/integrations/ai/skills.js";

export function createApp(): Application {
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request).rawBody = Buffer.from(buf);
      },
    })
  );
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

  app.get("/", (_req, res) => sendSuccessResponse(res, "Welcome to Auxhr Backend"));
  app.get(
    "/health",
    asyncHandler(async (_req, res) => {
      try {
        await AppDataSource.query("SELECT 1");
        res.json({ status: "ok", db: "connected", timestamp: new Date().toISOString() });
      } catch {
        res
          .status(503)
          .json({ status: "error", db: "disconnected", timestamp: new Date().toISOString() });
      }
    })
  );
  swaggerDocs(app, env.port);

  app.use("/v1", companyActivityLogger, v1Router);

  // Global error handler — must be last
  app.use(errorHandler);

  return app;
}

const warnAboutMissingAiKeys = (): void => {
  loadAiSkills();
  loadAiPrompts();
  const catalog = loadAiCatalog();
  const defaults = new Set(catalog.features.map((feature) => feature.default.provider));
  for (const provider of catalog.providers.filter((item) => defaults.has(item.key))) {
    if (!isProviderConfigured(provider)) {
      logger.warn(`${provider.envKey} isn't set, so AI jobs using ${provider.name} will fail`);
    }
  }
};

async function startApplication(): Promise<void> {
  warnAboutMissingAiKeys();
  await initializeDatabase();
  logger.info("Database connected successfully");

  const app = createApp();
  const PORT = env.port || 3000;

  const server = app.listen(PORT, () => {
    logger.info(`App listening on http://localhost:${PORT}`);
  });

  // Self-healing sweep for fire-and-forget LLM work (CV embeddings, match
  // verdicts, pre-screening generation). Runs in-process — no separate
  // worker/queue — so it only needs the Postgres connection we already have.
  const runSweep = () => {
    reconcileDurableJobs().catch((err: Error) =>
      logger.error(`Durable job reconciliation sweep failed: ${err.message}`)
    );
  };
  const reconcileInterval = setInterval(runSweep, SWEEP_INTERVAL_MS);
  reconcileInterval.unref();
  setTimeout(runSweep, 5_000).unref();

  const shutdown = (signal: string): void => {
    logger.info(`${signal} received — shutting down gracefully`);
    clearInterval(reconcileInterval);
    server.close(() => {
      void AppDataSource.destroy()
        .catch(() => {})
        .finally(() => process.exit(0));
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
