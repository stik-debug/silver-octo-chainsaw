# MtaaPro API (production backend core)

Real-data only: no seeded users, providers, bookings, payments or reviews. Empty DB => honest empty states.

## Stack
Node 20+, Express, TypeScript, PostgreSQL + Prisma, Africa's Talking (SMS OTP), Safaricom Daraja (STK Push).

## Setup
1. `cp .env.example .env` and fill it in. `npm install`
2. `npx prisma migrate dev --name init` (dev) / `npx prisma migrate deploy` (prod)
3. `npm run seed:dev` — inserts ONLY service categories (system config).
4. First admin: set `ADMIN_PHONE`, `ADMIN_NAME`, run `npm run create-admin` once. Log in via real OTP. Production blocks admin login until MFA is enrolled (MFA enrolment endpoint: TODO).
5. `npm run dev` or `npm run build && npm start`.

## Production dependencies
- **PostgreSQL**: managed instance with automated backups + point-in-time recovery. Never use a localhost/_dev URL (server refuses).
- **SMS**: Africa's Talking live username + API key + registered sender ID. Without a key, OTPs only print to the server console in `NODE_ENV=development`; they are never returned by the API.
- **M-Pesa (Daraja)**: create a Go-Live app, set `M_PESA_ENV=production`, shortcode, passkey, consumer key/secret. Callback URL must be public HTTPS: `https://<domain>/api/payments/mpesa/callback/<MPESA_CALLBACK_TOKEN>`. The server refuses to boot in production with sandbox config.
- **Object storage** (S3/R2/GCS): private bucket, presigned uploads; store only the key in `ProviderDocument.storageKey`. Never public.
- **Secrets**: use your host's secret manager. Never commit `.env`.
- **HTTPS / reverse proxy**, error tracking (Sentry), uptime monitoring, log shipping.

## Payment flow
Quote accepted -> `POST /api/payments/bookings/:id/pay` -> STK push -> `PENDING` -> Daraja callback (idempotent, unique CheckoutRequestID/receipt, every payload stored in `PaymentEvent`) -> `CONFIRMED` + ledger entries (customer payment, platform fee, provider earning) -> booking `SCHEDULED`. `POST /api/payments/:id/check` reconciles stuck payments via STK Query.

## Added since v1
- **Frontend** (`public/`): OTP login, 3D map (MapLibre GL, pitched view with 3D buildings from OpenFreeMap vector tiles), provider onboarding, bookings, payments, messages, notifications, disputes.
- **Realtime**: Server-Sent Events at `/api/stream` push notifications and new-message alerts. In-process only; for more than one API instance swap `src/lib/events.ts` for Redis pub/sub.
- **Map privacy**: pins use a ~1 km rounded location, never the provider's exact base.
- **Uploads**: presigned POST with a 5 MB cap and fixed content type, private bucket only. Set the bucket CORS to allow POST from your domain.
- **Payouts (B2C)**: needs Safaricom B2C approval, `MPESA_INITIATOR_NAME`, and `MPESA_SECURITY_CREDENTIAL` (initiator password encrypted with Safaricom's public certificate). Daraja must reach `PUBLIC_URL`.
- **MFA**: admins log in with TOTP. First login returns an enrolment-only token: call `POST /api/account/mfa/setup`, add the secret to an authenticator, then `POST /api/account/mfa/confirm {code}`.
- **Monitoring**: set `SENTRY_DSN`; `/health` checks the database (wire it to your uptime monitor). Use your platform's log drain.
- **Backups**: enable managed Postgres PITR; test a restore before launch.
- **CI / tests**: `npm test` (config safety tests), `npm run typecheck`; GitHub Actions in `.github/workflows/ci.yml`.

## First run checklist
`npm install && npx prisma generate && npx prisma migrate dev --name init && npm run typecheck && npm test`

## Testing
- `npm test` runs config-safety tests always, and **integration tests against real Postgres** when `RUN_DB_TESTS=1` and `DATABASE_URL` contains "test" (the suite truncates tables, so it refuses any other database). CI runs them against a Postgres service container.
- Covered: Daraja callback auth, payment confirmation + ledger (fee 10% / provider 90%), replay idempotency, failed-payment retry, booking state-machine permissions, review rules, ledger-based earnings, payout guard, verified-only search and the empty-state message.
- Verified in development: the type-check and all 14 tests passed against Prisma 6.19 and Postgres 16.

## Refunds and payouts
- Refund disputes record a ledger REFUND and, when `MPESA_INITIATOR_NAME`, `MPESA_SECURITY_CREDENTIAL` and `PUBLIC_URL` are set, request a Daraja Transaction Reversal automatically (result callback marks the payment REVERSED). Without them the response says `reversal: "MANUAL"` and an admin reverses in the Daraja portal.
- `POST /api/payouts/request` returns 503 "Payouts aren't enabled yet." until the same credentials are set. Both flows need Safaricom approval and have not been exercised against Daraja.

## Known gaps
Daraja, Africa's Talking, S3 and the map tile host have not been exercised end-to-end (sandbox run required before real money); the reversal and B2C calls follow Daraja's documented shape but are untested; free OpenFreeMap tiles should be replaced or self-hosted for production traffic; SSE needs Redis for multi-instance; the 3D view is MapLibre 3D buildings, not custom 3D provider models.
