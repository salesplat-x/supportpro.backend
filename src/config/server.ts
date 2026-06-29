import env from "./env.js";

const serverConfig = {
  port: env.port || 3000,
  corsOrigin: "*",
  generalRateLimit: {
    windowMs: 15 * 60 * 1000,
    max: 300,
  },
  authRateLimit: {
    windowMs: 15 * 60 * 1000,
    max: 10,
  },
};

export default serverConfig;
