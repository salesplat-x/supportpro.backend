import { connect } from "mongoose";
import logger from "./logger";
import env from "./env";
import { Pool } from "pg";

let dbUrl: string = env.db_database!;

function newMongoDBConnection(): Promise<void> {
  return new Promise((resolve, reject) => {
    connect(dbUrl)
      .then(() => {
        resolve(logger.log("MongoDB Connected"));
      })
      .catch((error: Error) => {
        reject(logger.log("MongoDB Connection Error: " + error.message));
      });
  });
}

const pool = new Pool({
  user: env.pg_user,
  host: env.pg_host,
  database: env.pg_db,
  password: env.pg_password,
  port: Number(env.pg_port),
});

export { newMongoDBConnection, pool };
