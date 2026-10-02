import test from "node:test";
import assert from "node:assert";
const ok = { DATABASE_URL: "postgresql://u:p@db.example.com:5432/mtaapro", JWT_SECRET: "x".repeat(40) };
const prod = { ...ok, NODE_ENV: "production", M_PESA_ENV: "production", MPESA_CONSUMER_KEY: "k", MPESA_CONSUMER_SECRET: "s", MPESA_SHORTCODE: "1", MPESA_PASSKEY: "p", MPESA_CALLBACK_TOKEN: "t", AT_API_KEY: "a" };
function load(env: Record<string, string>) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(NODE_ENV|M_PESA_ENV|MPESA_|AT_|DATABASE_URL|JWT_SECRET)/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve("../src/config")];
  try { return require("../src/config"); } finally { process.env = saved; }
}
test("development config loads", () => assert.ok(load(ok).cfg));
test("production refuses sandbox M-Pesa", () => assert.throws(() => load({ ...prod, M_PESA_ENV: "sandbox" }), /sandbox/));
test("production refuses a dev database", () => assert.throws(() => load({ ...prod, DATABASE_URL: "postgresql://u:p@localhost/mtaapro_dev" }), /development database/));
test("production requires secrets", () => assert.throws(() => load({ ...prod, MPESA_PASSKEY: "" }), /MPESA_PASSKEY/));
test("valid production config loads", () => assert.ok(load(prod).cfg));
test("short JWT secret is rejected", () => assert.throws(() => load({ ...ok, JWT_SECRET: "short" })));
