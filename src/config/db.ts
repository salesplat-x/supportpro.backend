import { connect } from "mongoose";
import logger from "./logger";
import env from "./env";

const dbUrl: string = env.db_database!;

function newMongoDBConnection(): Promise<void> {
  return new Promise((resolve, reject) => {
    connect(dbUrl)
      .then(() => {
        logger.log("MongoDB Connected");
        resolve();
      })
      .catch((error: Error) => {
        logger.logErrorMessage("MongoDB Connection Error: " + error.message);
        reject(error);
      });
  });
}

export { newMongoDBConnection };
