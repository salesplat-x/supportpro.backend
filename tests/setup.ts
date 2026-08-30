// Provides dummy env vars so env.ts can be imported without a real .env.
// PG_* vars are overridden at runtime by the Testcontainer in tests/helpers/db.ts.
process.env.PG_HOST ||= "localhost";
process.env.PG_PORT ||= "5432";
process.env.PG_DB ||= "supportpro-test";
process.env.PG_USER ||= "postgres";
process.env.PG_PASSWORD ||= "postgres";
process.env.PORT ||= "3003";
process.env.JWT_SECRET ||= "test-jwt-secret-for-automated-tests-only-min32chars!!";
process.env.SALT_ROUNDS ||= "4";
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";
process.env.PAYSTACK_PAYMENT_URL ||= "https://api.paystack.co";
process.env.PAYSTACK_SECRET_KEY ||= "sk_test_placeholder";
process.env.PAYSTACK_PUBLIC_KEY ||= "pk_test_placeholder";
process.env.PAYSTACK_MODE ||= "dummy";
process.env.PAYSTACK_WHITELISTED_IPS = process.env.PAYSTACK_WHITELISTED_IPS ?? "";
process.env.FRONTEND_CALLBACK_URL ||= "http://localhost:5173";
process.env.RESEND_API_KEY ||= "test-resend-api-key";
process.env.RESEND_SENDER_EMAIL ||= "test@example.com";
process.env.RESEND_SENDER_NAME ||= "Test Sender";
