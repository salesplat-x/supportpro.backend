# Getting the Remaining `.env` Credentials

`src/config/env.ts` requires every variable below to be **non-empty** or the app throws at
startup (`Missing required environment variables: ...`). The values you already have
(`DB_URI`, `JWT_SECRET`, `PORT`, `SALT_ROUNDS`, `PG_*`, `FRONTEND_CALLBACK_URL`,
`PAYSTACK_PAYMENT_URL`) are local-only and don't need real third-party accounts. The ones below
do need real (or dummy-but-non-empty) values depending on what you're testing.

---

## OPENAI_API_KEY

Used by `src/services/v1/openai.ts` for AI-powered scout/scoring features.

1. Go to https://platform.openai.com/ and sign in / create an account.
2. Go to **API keys** (https://platform.openai.com/api-keys).
3. Click **Create new secret key**, copy it immediately (shown only once).
4. New accounts may need a payment method added under **Billing** before keys work.

If you're not testing AI features, you can put any non-empty placeholder (e.g. `sk-test`) so
the app starts — calls to OpenAI will just fail when those specific endpoints are hit.

```
OPENAI_API_KEY=sk-...
```

---

## CLOUDINARY_NAME / CLOUDINARY_KEY / CLOUDINARY_SECRET

Used by `src/services/v1/cloudinary.ts` for file/image uploads (CVs, profile pictures, etc.).

1. Go to https://cloudinary.com/users/register/free and create a free account.
2. After signup you land on the **Dashboard**, which shows:
   - **Cloud name** → `CLOUDINARY_NAME`
   - **API Key** → `CLOUDINARY_KEY`
   - **API Secret** → `CLOUDINARY_SECRET` (click "reveal")

```
CLOUDINARY_NAME=your-cloud-name
CLOUDINARY_KEY=123456789012345
CLOUDINARY_SECRET=abc123...
```

If you're not testing upload features, any non-empty placeholder string works for startup;
upload calls will fail with auth errors until real values are set.

---

## PAYSTACK_SECRET_KEY / PAYSTACK_PUBLIC_KEY / PAYSTACK_WHITELISTED_IPS

Used by `src/services/v1/paystack.ts` for subscriptions/payments, and
`src/middlewares/v1/verifyWebhookIP.ts` for verifying inbound webhook calls.

1. Go to https://dashboard.paystack.com/#/signup and create an account (Nigerian business
   details aren't required for **test mode**).
2. Go to **Settings → API Keys & Webhooks** (https://dashboard.paystack.com/#/settings/developers).
3. Make sure you're toggled to **Test Mode** (top of dashboard).
4. Copy:
   - **Test Secret Key** (`sk_test_...`) → `PAYSTACK_SECRET_KEY`
   - **Test Public Key** (`pk_test_...`) → `PAYSTACK_PUBLIC_KEY`

### `PAYSTACK_WHITELISTED_IPS`
This is the list of IPs allowed to call your `/payment/webhook` route (checked in
`verifyWebhookIP.ts`). Paystack publishes its webhook source IPs in their docs
(Settings → Webhooks page also lists them). For **local testing**, webhooks from Paystack can't
reach `localhost` directly anyway (you'd need a tunnel like ngrok), so:

- If you're not testing webhooks locally, set this to a harmless placeholder, e.g. your own
  machine's IP or `127.0.0.1`, just so it's non-empty.
- If you do want to test webhooks locally: run `ngrok http <PORT>`, register the ngrok URL +
  `/v1/payment/webhook` path as the webhook URL in Paystack's dashboard, and set
  `PAYSTACK_WHITELISTED_IPS` to the comma-separated IPs Paystack documents for webhook calls.

```
PAYSTACK_SECRET_KEY=sk_test_...
PAYSTACK_PUBLIC_KEY=pk_test_...
PAYSTACK_WHITELISTED_IPS=127.0.0.1
```

---

## BREVO_API_KEY / BREVO_SENDER_EMAIL / BREVO_SENDER_NAME

Used by `src/services/v1/email/providers/brevo.provider.ts` (welcome and password-reset emails,
sent via `EmailService`) to call Brevo's transactional email REST API
(`https://api.brevo.com/v3/smtp/email`).

> Note: `EmailService.sendEmail()` catches and logs any provider error
> (`logger.logErrorMessage`) rather than throwing, so a misconfigured or failing Brevo
> integration will never block registration, login, or password-reset — it just means the
> email won't arrive. You still need non-empty values for the app to start.

### Setup steps

1. Go to https://www.brevo.com/ and create a free account (no credit card required).
2. **Verify a sender**: go to **Senders, Domains & Dedicated IPs → Senders**
   (https://app.brevo.com/senders/list) and add/verify the email address you'll send from
   (Brevo emails a confirmation link). This becomes `BREVO_SENDER_EMAIL`; the display name you
   give it becomes `BREVO_SENDER_NAME`.
3. **Generate an API key**: go to **Settings → SMTP & API → API Keys**
   (https://app.brevo.com/settings/keys/api), click **Generate a new API key**, name it (e.g.
   "supportpro-local"), and copy it immediately (shown only once). This is `BREVO_API_KEY`.
4. Set the three env vars below.
5. **Test delivery**: trigger a registration or `forgot-password` request locally and confirm
   the email arrives. Check the app logs for `Failed to send email to ...` if it doesn't.
6. If sends fail, double-check **sender authentication** — Brevo may require domain
   verification (SPF/DKIM records) for sending from a custom domain; verifying a single mailbox
   address (step 2) is enough to get started.

```
BREVO_API_KEY=xkeysib-...
BREVO_SENDER_EMAIL=youraddress@example.com
BREVO_SENDER_NAME=AuxHR
```

### Common issues

- **401 Unauthorized** — `BREVO_API_KEY` is missing, mistyped, or has been revoked; generate a
  new key.
- **400 "sender not valid"** — `BREVO_SENDER_EMAIL` hasn't been verified in Brevo yet (step 2).
- **Free tier limit** — Brevo's free plan caps you at 300 emails/day; sends beyond that will
  fail until the next day or until you upgrade.

If you just need the server to boot, any non-empty placeholder works for all three vars —
`EmailService` will log a failure on send but won't crash the app.

---

## Quick local-dev shortcut

If you just want `npm run dev`/`npm start` to boot without testing payments, uploads, AI, or
email, you can fill every remaining var with a clearly-fake non-empty placeholder:

```
OPENAI_API_KEY=sk-local-placeholder
CLOUDINARY_NAME=local-placeholder
CLOUDINARY_KEY=local-placeholder
CLOUDINARY_SECRET=local-placeholder
PAYSTACK_SECRET_KEY=sk_test_placeholder
PAYSTACK_PUBLIC_KEY=pk_test_placeholder
PAYSTACK_WHITELISTED_IPS=127.0.0.1
BREVO_API_KEY=placeholder
BREVO_SENDER_EMAIL=placeholder@example.com
BREVO_SENDER_NAME=placeholder
```

The auth, job, and core CRUD endpoints don't depend on these — only the specific
upload/payment/AI/email-sending features will fail until real credentials are added.
