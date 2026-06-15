// Provides dummy values for env.ts's required vars so the app can be
// imported in tests without a real .env file (e.g. in CI).
process.env.DB_URI ||= "mongodb://localhost:27017/supportpro-test";
process.env.PG_HOST ||= "localhost";
process.env.PG_PORT ||= "5432";
process.env.PG_DB ||= "supportpro-test";
process.env.PG_USER ||= "postgres";
process.env.PG_PASSWORD ||= "postgres";
process.env.PORT ||= "3003";
process.env.JWT_SECRET ||= "test-jwt-secret-for-automated-tests-only";
process.env.SALT_ROUNDS ||= "4";
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";
process.env.CLOUDINARY_NAME ||= "test-placeholder";
process.env.CLOUDINARY_KEY ||= "test-placeholder";
process.env.CLOUDINARY_SECRET ||= "test-placeholder";
process.env.PAYSTACK_PAYMENT_URL ||= "https://api.paystack.co";
process.env.PAYSTACK_SECRET_KEY ||= "sk_test_placeholder";
process.env.PAYSTACK_PUBLIC_KEY ||= "pk_test_placeholder";
process.env.PAYSTACK_WHITELISTED_IPS ||= "127.0.0.1";
process.env.FRONTEND_CALLBACK_URL ||= "http://localhost:5173";
process.env.WEBSITE ||= "http://localhost:5173";
process.env.BREVO_API_KEY ||= "test-brevo-api-key";
process.env.BREVO_SENDER_EMAIL ||= "test@example.com";
process.env.BREVO_SENDER_NAME ||= "Test Sender";
