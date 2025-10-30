const validEnvs = ["dev", "production", "staging", "test"] as const;
type AppEnv = (typeof validEnvs)[number];

const getEnv = (): AppEnv => {
  return validEnvs.find((_) => _ === process.env.NODE_ENV) ?? "dev";
};

const optionalEnvVars = {
  app_env: getEnv(),
} as const;

const requiredEnvVars = {
  db_database: process.env.DB_URI,
  pg_host: process.env.PG_HOST,
  pg_port: process.env.PG_PORT,
  pg_db: process.env.PG_DB,
  pg_user: process.env.PG_USER,
  pg_password: process.env.PG_PASSWORD,
  port: Number(process.env.PORT),
  jwt_secret: process.env.JWT_SECRET,
  salt_rounds: Number(process.env.SALT_ROUNDS) || 10,
  openai_secret: process.env.OPENAI_API_KEY,
  cloudinary_name: process.env.CLOUDINARY_NAME,
  cloudinary_key: process.env.CLOUDINARY_KEY,
  cloudinary_secret: process.env.CLOUDINARY_SECRET,
  paystackUrl: process.env.PAYSTACK_PAYMENT_URL,
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY,
  paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY,
  whitelisted_ips: process.env.PAYSTACK_WHITELISTED_IPS,
  website: process.env.FRONTEND_CALLBACK_URL,
  email_username: process.env.EMAIL_USERNAME,
  email_password: process.env.EMAIL_PASSWORD,
  email_host: process.env.EMAIL_HOST,
  email_port: process.env.EMAIL_PORT || 465,
} as const;

const env = {
  ...optionalEnvVars,
  ...requiredEnvVars,
} as const;

const missingEnvVars = Object.entries(requiredEnvVars)
  .filter(([key, value]) => {
    return !value;
  })
  .map(([key, _]) => key);

if (missingEnvVars.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingEnvVars.join(", ")}`
  );
}

export default env;
