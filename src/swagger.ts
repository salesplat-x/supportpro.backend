import { Application, Request, Response, NextFunction } from "express";
import swaggerUi from "swagger-ui-express";
import logger from "./config/logger";
import fs from "fs";
import yaml from "js-yaml";
import path from "path";

function loadSwaggerSpec(): swaggerUi.JsonObject | null {
  try {
    const filePath = path.join(__dirname, "../swagger.yaml");
    if (!fs.existsSync(filePath)) {
      throw new Error("Swagger file not found");
    }

    const fileContents = fs.readFileSync(filePath, "utf8");
    return yaml.load(fileContents) as swaggerUi.JsonObject;
  } catch (error) {
    console.error("Error loading Swagger spec:", error);
    return null;
  }
}

// Serve Swagger UI
//const swaggerSpec = loadSwaggerSpec();

function swaggerDocs(app: Application, port: number) {
  app.use("/v1/docs", swaggerUi.serve);

  // Middleware that will load spec per request and invoke the setup middleware
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
}

export default swaggerDocs;
