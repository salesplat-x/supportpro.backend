import winston from "winston";
import morgan from "morgan";
import path from "path";
import fs from "fs";

const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const colors: { [key: string]: string } = {
  error: "red",
  warn: "yellow",
  info: "green",
  http: "magenta",
  debug: "orange",
};

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss:ms" }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss:ms" }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}`
  )
);

const logger = winston.createLogger({
  level: "debug",
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
  },
  format: fileFormat,
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat,
    }),

    // Error log file
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      format: fileFormat,
    }),

    // Combined log file
    new winston.transports.File({
      filename: path.join(logsDir, "combined.log"),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      format: fileFormat,
    }),
  ],
});

winston.addColors(colors);

const handleLogs: morgan.StreamOptions = {
  write: (log: string) => {
    logger.http(log);
  },
};

const logan = morgan(
  ":method :url :status :res[content-length] - :response-time ms",
  {
    stream: handleLogs,
  }
);

const logErrorToConsole = (err: Error) => {
  logger.error(err.stack || err);
};

const log = (message: string) => {
  logger.info(message);
};

const logErrorMessage = (message: string) => {
  logger.error(message);
};

export default { logan, logErrorToConsole, log, logErrorMessage };
