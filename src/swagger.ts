import { Application, Request, Response, NextFunction } from "express";
import swaggerUi from "swagger-ui-express";
import logger from "./config/logger";
import fs from "fs";
import yaml from "js-yaml";
import path from "path";

const loadSwaggerSpec = (): swaggerUi.JsonObject | null => {
  try {
    const filePath = path.join(__dirname, "../swagger.yaml");
    if (!fs.existsSync(filePath)) {
      throw new Error("Swagger file not found");
    }
    return yaml.load(fs.readFileSync(filePath, "utf8")) as swaggerUi.JsonObject;
  } catch (error) {
    console.error("Error loading Swagger spec:", error);
    return null;
  }
};

const swaggerDocs = (app: Application, port: number): void => {
  app.use("/v1/docs", swaggerUi.serve);

  app.get("/v1/docs", (req: Request, res: Response, next: NextFunction) => {
    const swaggerSpec = loadSwaggerSpec();
    if (!swaggerSpec) {
      return res.status(500).send("Swagger spec not available");
    }
    return swaggerUi.setup(swaggerSpec)(req, res, next);
  });

  app.get("/v1/docs.json", (req: Request, res: Response) => {
    const swaggerSpec = loadSwaggerSpec();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.send(swaggerSpec);
  });

  logger.log(`Docs available at http://localhost:${port}/v1/docs`);
};

export default swaggerDocs;
