import env from "./env.js";

const authConfig = {
  jwtSecret: env.jwt_secret as string,
  saltRounds: env.salt_rounds,
  tokenExpiresIn: "1d" as const,
};

export default authConfig;
