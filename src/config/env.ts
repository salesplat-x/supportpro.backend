const validEnvs = ["dev", "production", "staging", "test"] as const;
type AppEnv = (typeof validEnvs)[number];

const getEnv = (): AppEnv => {
  return validEnvs.find((_) => _ === process.env.NODE_ENV) ?? "dev";
};

const optionalEnvVars = {
  app_env: getEnv(),
  openai_secret: process.env.OPENAI_API_KEY,
  cloudinary_name: process.env.CLOUDINARY_NAME,
  cloudinary_key: process.env.CLOUDINARY_KEY,
  cloudinary_secret: process.env.CLOUDINARY_SECRET,
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY,
  paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY,
  whitelisted_ips: process.env.PAYSTACK_WHITELISTED_IPS,
  brevo_api_key: process.env.BREVO_API_KEY,
  brevo_sender_email: process.env.BREVO_SENDER_EMAIL,
  brevo_sender_name: process.env.BREVO_SENDER_NAME,
} as const;

const requiredEnvVars = {
  pg_host: process.env.PG_HOST,
  pg_port: process.env.PG_PORT,
  pg_db: process.env.PG_DB,
  pg_user: process.env.PG_USER,
  pg_password: process.env.PG_PASSWORD,
  port: Number(process.env.PORT),
  jwt_secret: process.env.JWT_SECRET,
  salt_rounds: Number(process.env.SALT_ROUNDS) || 10,
  paystackUrl: process.env.PAYSTACK_PAYMENT_URL,
  website: process.env.FRONTEND_CALLBACK_URL,
} as const;

const env = {
  ...optionalEnvVars,
  ...requiredEnvVars,
} as const;

const missingEnvVars = Object.entries(requiredEnvVars)
  .filter(([, value]) => {
    return !value;
  })
  .map(([key]) => key);

if (missingEnvVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnvVars.join(", ")}`);
}

if (env.jwt_secret!.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long");
}

export default env;
