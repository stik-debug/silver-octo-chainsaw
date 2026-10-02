import { Router } from "express";
import { db, audit, notify } from "../lib/db";
import { requireAuth, Authed } from "../lib/auth";
import { stkPush, stkQuery } from "../lib/mpesa";
import { move } from "./bookings";
import { cfg } from "../config";
const r = Router();

// Amount always comes from the DB quote, never from the client.
r.post("/bookings/:id/pay", requireAuth(), async (req, res) => {
  const uid = (req as unknown as Authed).uid;
  const b = await db.booking.findUnique({ where: { id: req.params.id } });
  const phone = String(req.body.phone || "");
  if (!b || b.customerId !== uid || b.status !== "QUOTE_ACCEPTED" || !b.quoteKes || !/^254\d{9}$/.test(phone))
    return res.status(409).json({ error: "This booking isn't ready for payment." });
  const pay = await db.payment.create({ data: { bookingId: b.id, amountKes: b.quoteKes, phone } });
  try {
    const { ok, body } = await stkPush(phone, b.quoteKes, b.id);
    await db.paymentEvent.create({ data: { paymentId: pay.id, source: "stk_request", payload: body } });
    if (!ok || body.ResponseCode !== "0") {
      await db.payment.update({ where: { id: pay.id }, data: { status: "FAILED", failureReason: body.errorMessage || body.ResponseDescription } });
      return res.status(502).json({ error: "M-Pesa couldn't start the payment. You have not been charged." });
    }
    await db.payment.update({ where: { id: pay.id }, data: { status: "PENDING", checkoutRequestId: body.CheckoutRequestID, merchantRequestId: body.MerchantRequestID } });
    await move(b.id, "PAYMENT_PENDING", uid);
    res.status(202).json({ paymentId: pay.id, status: "PENDING", message: "Check your phone and enter your M-Pesa PIN." });
  } catch {
    res.status(502).json({ error: "We couldn't reach M-Pesa. Please try again shortly." });
  }
});

// Idempotent settlement shared by the callback and status-query reconciliation.
async function settle(checkoutRequestId: string, resultCode: number, desc: string, receipt?: string, source = "callback", raw?: object) {
  const pay = await db.payment.findUnique({ where: { checkoutRequestId }, include: { booking: { include: { provider: true } } } });
  if (!pay) return;
  await db.paymentEvent.create({ data: { paymentId: pay.id, source, payload: (raw ?? { resultCode, desc }) as any } });
  if (pay.status === "CONFIRMED" || pay.status === "FAILED" || pay.status === "TIMEOUT") return;
  if (resultCode !== 0) {
    await db.payment.update({ where: { id: pay.id }, data: { status: resultCode === 1037 ? "TIMEOUT" : "FAILED", failureReason: desc } });
    await move(pay.bookingId, "QUOTE_ACCEPTED", null); // customer may retry
    return void (await notify(pay.booking.customerId, "PAYMENT_FAILED", "Your M-Pesa payment did not go through."));
  }
  const fee = Math.round((pay.amountKes * cfg.PLATFORM_FEE_PERCENT) / 100);
  const row = (type: any, amountKes: number) => ({ type, paymentId: pay.id, bookingId: pay.bookingId, providerId: pay.booking.providerId, amountKes });
  await db.$transaction([
    db.payment.update({ where: { id: pay.id }, data: { status: "CONFIRMED", mpesaReceipt: receipt } }),
    db.ledgerEntry.create({ data: row("CUSTOMER_PAYMENT", pay.amountKes) }),
    db.ledgerEntry.create({ data: row("PLATFORM_FEE", fee) }),
    db.ledgerEntry.create({ data: row("PROVIDER_EARNING", pay.amountKes - fee) }),
  ]);
  await move(pay.bookingId, "PAID", null);
  await move(pay.bookingId, "SCHEDULED", null);
  await audit(null, "PAYMENT_CONFIRMED", "Payment", pay.id, { receipt });
  await notify(pay.booking.customerId, "PAYMENT_CONFIRMED", "Payment confirmed.");
  await notify(pay.booking.provider.userId, "PAYMENT_CONFIRMED", "The customer's payment is confirmed.");
}
r.post("/mpesa/callback/:token", async (req, res) => {
  if (req.params.token !== cfg.MPESA_CALLBACK_TOKEN) return res.sendStatus(404);
  try {
    const cb = req.body?.Body?.stkCallback;
    if (cb) {
      const receipt = (cb.CallbackMetadata?.Item || []).find((i: any) => i.Name === "MpesaReceiptNumber")?.Value;
      await settle(cb.CheckoutRequestID, cb.ResultCode, cb.ResultDesc, receipt, "callback", req.body);
    }
  } catch (e) { console.error("callback error", e); }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});
r.post("/mpesa/reversal-result/:token", async (q, s) => {
  if (q.params.token !== cfg.MPESA_CALLBACK_TOKEN) return s.sendStatus(404);
  try {
    const res = q.body?.Result;
    const ev = res && (await db.paymentEvent.findFirst({ where: { source: "reversal_request", payload: { path: ["OriginatorConversationID"], equals: res.OriginatorConversationID } } }));
    if (ev?.paymentId) {
      await db.paymentEvent.create({ data: { paymentId: ev.paymentId, source: "reversal_result", payload: q.body } });
      if (res.ResultCode === 0) await db.payment.update({ where: { id: ev.paymentId }, data: { status: "REVERSED" } });
    }
  } catch (e) { console.error(e); }
  s.json({ ResultCode: 0, ResultDesc: "Accepted" });
});
r.post("/:id/check", requireAuth(), async (req, res) => {
  const p = await db.payment.findUnique({ where: { id: req.params.id }, include: { booking: true } });
  if (!p || p.booking.customerId !== (req as unknown as Authed).uid) return res.sendStatus(404);
  if (p.status === "PENDING" && p.checkoutRequestId) {
    const q = await stkQuery(p.checkoutRequestId).catch(() => null);
    if (q && q.ResultCode !== undefined) await settle(p.checkoutRequestId, Number(q.ResultCode), q.ResultDesc, undefined, "status_query", q);
  }
  const fresh = await db.payment.findUnique({ where: { id: p.id } });
  res.json({ status: fresh!.status, message: fresh!.status === "PENDING" ? "We couldn't confirm your M-Pesa payment yet. Please wait while we check." : undefined });
});
// Provider earnings: server-side from the ledger only.
r.get("/earnings", requireAuth("PROVIDER"), async (req, res) => {
  const p = await db.providerProfile.findUniqueOrThrow({ where: { userId: (req as unknown as Authed).uid } });
  const sum = async (where: object) => (await db.ledgerEntry.aggregate({ where: { providerId: p.id, ...where }, _sum: { amountKes: true } }))._sum.amountKes ?? 0;
  const ids = (await db.booking.findMany({ where: { providerId: p.id, status: "CONFIRMED" }, select: { id: true } })).map(b => b.id);
  const earned = await sum({ type: "PROVIDER_EARNING" });
  const released = ids.length ? await sum({ type: "PROVIDER_EARNING", bookingId: { in: ids } }) : 0;
  const paidOut = await sum({ type: "PROVIDER_PAYOUT" });
  res.json({ totalEarnedKes: earned, pendingKes: earned - released, availableKes: released - paidOut, paidOutKes: paidOut,
    message: earned ? undefined : "Earnings will appear after you complete paid jobs." });
});
export default r;
