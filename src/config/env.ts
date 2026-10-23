const validEnvs = ["dev", "production", "staging", "test"] as const;
type AppEnv = (typeof validEnvs)[number];

const getEnv = (): AppEnv => {
  return validEnvs.find((_) => _ === process.env.NODE_ENV) ?? "dev";
};

const paystackModeRaw = (process.env.PAYSTACK_MODE ?? "dummy").toLowerCase();
const paystackMode = paystackModeRaw === "paystack" ? "paystack" : "dummy";

const positiveNumberOr = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const optionalEnvVars = {
  app_env: getEnv(),
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY,
  paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY,
  whitelisted_ips: process.env.PAYSTACK_WHITELISTED_IPS,
  paystackMode,
  paystackPlanCodeMonthly: process.env.PAYSTACK_PLAN_CODE_PAID_MONTHLY,
  paystackPlanCodeAnnually: process.env.PAYSTACK_PLAN_CODE_PAID_ANNUALLY,
  resend_api_key: process.env.RESEND_API_KEY,
  resend_sender_email: process.env.RESEND_SENDER_EMAIL,
  resend_sender_name: process.env.RESEND_SENDER_NAME,
  doSpacesEndpoint: process.env.DO_SPACES_ENDPOINT,
  doSpacesRegion: process.env.DO_SPACES_REGION,
  doSpacesBucket: process.env.DO_SPACES_BUCKET,
  doSpacesKey: process.env.DO_SPACES_KEY,
  doSpacesSecret: process.env.DO_SPACES_SECRET,
  // Voice replies (text-to-speech). Optional: without them the voice endpoints answer with
  // the canned fallback clip instead of failing, and the rest of the API is unaffected.
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
  elevenlabsVoiceId: process.env.ELEVENLABS_VOICE_ID,
  elevenlabsModelId: process.env.ELEVENLABS_MODEL_ID,
  // Longest recording the voice endpoints accept. Whisper bills per minute, and a 10 MB
  // Opus file can hold over an hour, so length is capped as well as size.
  voiceMaxDurationSeconds: positiveNumberOr(process.env.VOICE_MAX_DURATION_SECONDS, 120),
  // Each voice provider call (Whisper, the reply model, ElevenLabs) gives up after this long.
  voiceCallTimeoutMs: positiveNumberOr(process.env.VOICE_CALL_TIMEOUT_MS, 20_000),
  // The whole voice request ends by then (fallback clip or 504), inside Cloudflare's ~100 s cutoff.
  voiceRequestDeadlineMs: positiveNumberOr(process.env.VOICE_REQUEST_DEADLINE_MS, 60_000),
  // Voice calls get their own pool so they can't hold the shared OpenAI slots.
  voiceConcurrency: positiveNumberOr(process.env.VOICE_CONCURRENCY, 2),
} as const;

const requiredEnvVars = {
  // Used by utils/integrations/openai.ts for all LLM calls (personality /
  // personalized question generation, grading, AI Match, etc.).
  openai_secret: process.env.OPENAI_API_KEY,
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

const allowedOrigins = (process.env.FRONTEND_CALLBACK_URL ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const env = {
  ...optionalEnvVars,
  ...requiredEnvVars,
  website: allowedOrigins[0],
  allowedOrigins,
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
