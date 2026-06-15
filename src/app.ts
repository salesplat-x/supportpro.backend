import logger from "./config/logger";
import startApplication from "./server";

startApplication().catch((error: Error) => {
  logger.logErrorMessage(`Failed to start application: ${error.message}`);
  process.exit(1);
});
