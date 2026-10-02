// Integration tests against a REAL Postgres (never run against a non-test DB: guarded below).
import test, { before, after } from "node:test";
import assert from "node:assert";
const RUN = !!process.env.RUN_DB_TESTS && /test/.test(process.env.DATABASE_URL || "");
process.env.JWT_SECRET ||= "t".repeat(40);
process.env.MPESA_CALLBACK_TOKEN = "tok";
let base = "", db: any, srv: any, tok: (id: string, role: string) => string;
const call = async (path: string, who?: string, body?: any, method?: string) => {
  const r = await fetch(base + path, { method: method || (body ? "POST" : "GET"), headers: { "Content-Type": "application/json", ...(who ? { Authorization: "Bearer " + who } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const cb = (id: string, code: number, receipt?: string) => ({ Body: { stkCallback: { CheckoutRequestID: id, ResultCode: code, ResultDesc: code ? "failed" : "ok",
  CallbackMetadata: code ? undefined : { Item: [{ Name: "MpesaReceiptNumber", Value: receipt }] } } } });
let n = 0;
async function world(status: string, withPayment = true) {
  n++;
  const customer = await db.user.create({ data: { phone: `2547000000${n}${n}`, name: "C" + n } });
  const pu = await db.user.create({ data: { phone: `2547100000${n}${n}`, name: "P" + n, role: "PROVIDER" } });
  const cat = await db.serviceCategory.upsert({ where: { slug: "plumbing" }, update: {}, create: { slug: "plumbing", name: "Plumbing" } });
  const prov = await db.providerProfile.create({ data: { userId: pu.id, legalName: "Prov " + n, status: "ACTIVE", verification: "VERIFIED", available: true, lat: -1.29, lng: 36.82, serviceRadiusKm: 10, payoutPhone: "254711000000",
    services: { create: [{ categoryId: cat.id }] } } });
  const b = await db.booking.create({ data: { customerId: customer.id, providerId: prov.id, categoryId: cat.id, description: "Fix the kitchen sink", status, quoteKes: 1000 } });
  const pay = withPayment ? await db.payment.create({ data: { bookingId: b.id, amountKes: 1000, phone: "254700000000", status: "PENDING", checkoutRequestId: "ws_CO_" + n } }) : null;
  return { customer, pu, prov, b, pay, ct: tok(customer.id, "CUSTOMER"), pt: tok(pu.id, "PROVIDER") };
}
before(async () => {
  if (!RUN) return;
  db = require("../src/lib/db").db; tok = require("../src/lib/auth").signAccess;
  await db.$executeRawUnsafe(`TRUNCATE "User","OtpCode","Session","ServiceCategory","AuditLog","SupportTicket","Dispute","LedgerEntry","PaymentEvent","Payment","Booking","BookingEvent" RESTART IDENTITY CASCADE`);
  srv = require("../src/app").app.listen(0); base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => { if (RUN) { srv.close(); await db.$disconnect(); } });
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !RUN && "set RUN_DB_TESTS=1 and a *test* DATABASE_URL" }, fn);

t("callback with wrong token is rejected", async () => assert.equal((await call("/api/payments/mpesa/callback/nope", undefined, cb("x", 0))).status, 404));
t("successful callback confirms payment, writes ledger, schedules booking; replay is idempotent", async () => {
  const w = await world("PAYMENT_PENDING");
  for (let i = 0; i < 2; i++) assert.equal((await call("/api/payments/mpesa/callback/tok", undefined, cb(w.pay.checkoutRequestId, 0, "RCP" + n))).status, 200);
  const pay = await db.payment.findUnique({ where: { id: w.pay.id } });
  assert.equal(pay.status, "CONFIRMED"); assert.equal(pay.mpesaReceipt, "RCP" + n);
  const led = await db.ledgerEntry.findMany({ where: { paymentId: w.pay.id } });
  assert.equal(led.length, 3);
  assert.equal(led.find((l: any) => l.type === "PLATFORM_FEE").amountKes, 100);
  assert.equal(led.find((l: any) => l.type === "PROVIDER_EARNING").amountKes, 900);
  assert.equal((await db.booking.findUnique({ where: { id: w.b.id } })).status, "SCHEDULED");
});
t("failed callback marks FAILED and lets the customer retry", async () => {
  const w = await world("PAYMENT_PENDING");
  await call("/api/payments/mpesa/callback/tok", undefined, cb(w.pay.checkoutRequestId, 1032));
  assert.equal((await db.payment.findUnique({ where: { id: w.pay.id } })).status, "FAILED");
  assert.equal((await db.booking.findUnique({ where: { id: w.b.id } })).status, "QUOTE_ACCEPTED");
  assert.equal(await db.ledgerEntry.count({ where: { paymentId: w.pay.id } }), 0);
});
t("booking state machine enforces who may do what", async () => {
  const w = await world("REQUESTED", false);
  assert.equal((await call(`/api/bookings/${w.b.id}/transition`, w.ct, { to: "ACCEPTED" })).status, 409);   // customer can't accept
  assert.equal((await call(`/api/bookings/${w.b.id}/transition`, w.pt, { to: "CONFIRMED" })).status, 409);  // provider can't skip ahead
  assert.equal((await call(`/api/bookings/${w.b.id}/transition`, w.pt, { to: "ACCEPTED" })).status, 200);
  const other = tok((await db.user.create({ data: { phone: "254799999999", name: "X" } })).id, "CUSTOMER");
  assert.equal((await call(`/api/bookings/${w.b.id}/transition`, other, { to: "CANCELLED" })).status, 409);  // stranger
  assert.equal((await call(`/api/bookings/${w.b.id}/quote`, w.pt, { amountKes: 1500 })).status, 200);
  assert.equal((await db.bookingEvent.count({ where: { bookingId: w.b.id } })), 2);
});
t("payment can't be started for a booking without an accepted quote", async () => {
  const w = await world("REQUESTED", false);
  assert.equal((await call(`/api/payments/bookings/${w.b.id}/pay`, w.ct, { phone: "254700000000" })).status, 409);
});
t("reviews: only confirmed bookings, once", async () => {
  const w = await world("COMPLETED", false);
  assert.equal((await call(`/api/bookings/${w.b.id}/review`, w.ct, { rating: 5 })).status, 409);
  await db.booking.update({ where: { id: w.b.id }, data: { status: "CONFIRMED" } });
  assert.equal((await call(`/api/bookings/${w.b.id}/review`, w.ct, { rating: 5, text: "Great" })).status, 201);
  assert.equal((await call(`/api/bookings/${w.b.id}/review`, w.ct, { rating: 1 })).status, 409);
  assert.equal((await call(`/api/bookings/${w.b.id}/review`, w.pt, { rating: 5 })).status, 409);
});
t("earnings come from the ledger; payouts are blocked until B2C is configured", async () => {
  const w = await world("PAYMENT_PENDING");
  await call("/api/payments/mpesa/callback/tok", undefined, cb(w.pay.checkoutRequestId, 0, "RCPE" + n));
  let e = (await call("/api/payments/earnings", w.pt)).json;
  assert.equal(e.totalEarnedKes, 900); assert.equal(e.pendingKes, 900); assert.equal(e.availableKes, 0);
  await db.booking.update({ where: { id: w.b.id }, data: { status: "CONFIRMED" } });
  e = (await call("/api/payments/earnings", w.pt)).json; assert.equal(e.availableKes, 900);
  assert.equal((await call("/api/payouts/request", w.pt, {})).status, 503);
});
t("search hides unverified providers and shows the honest empty message", async () => {
  const w = await world("REQUESTED", false);
  const q = "/api/providers/search?category=plumbing&lat=-1.29&lng=36.82&radiusKm=5";
  const hit = (await call(q, w.ct)).json; assert.ok(hit.providers.some((p: any) => p.id === w.prov.id)); assert.ok(hit.providers[0].approx);
  await db.providerProfile.update({ where: { id: w.prov.id }, data: { verification: "PENDING" } });
  await db.providerProfile.updateMany({ where: { id: { not: w.prov.id } }, data: { verification: "PENDING" } });
  const none = (await call(q, w.ct)).json; assert.equal(none.providers.length, 0); assert.equal(none.message, "No verified providers available in this area yet.");
});
