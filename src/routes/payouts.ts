import { Router } from "express";
import { db, audit, notify } from "../lib/db";
import { requireAuth, Authed } from "../lib/auth";
import { b2c } from "../lib/mpesa";
import { cfg } from "../config";
const r = Router();

// Available = earnings on CONFIRMED bookings minus payouts (paid + in flight). Server-side only.
async function available(providerId: string) {
  const ids = (await db.booking.findMany({ where: { providerId, status: "CONFIRMED" }, select: { id: true } })).map(b => b.id);
  const released = ids.length ? (await db.ledgerEntry.aggregate({ where: { providerId, type: "PROVIDER_EARNING", bookingId: { in: ids } }, _sum: { amountKes: true } }))._sum.amountKes ?? 0 : 0;
  const paid = (await db.ledgerEntry.aggregate({ where: { providerId, type: "PROVIDER_PAYOUT" }, _sum: { amountKes: true } }))._sum.amountKes ?? 0;
  const inflight = (await db.providerPayout.aggregate({ where: { providerId, status: "PENDING" }, _sum: { amountKes: true } }))._sum.amountKes ?? 0;
  return released - paid - inflight;
}
r.post("/request", requireAuth("PROVIDER"), async (q, s) => {
  if (!cfg.MPESA_INITIATOR_NAME || !cfg.MPESA_SECURITY_CREDENTIAL || !cfg.PUBLIC_URL) return s.status(503).json({ error: "Payouts aren't enabled yet." });
  const p = await db.providerProfile.findUniqueOrThrow({ where: { userId: (q as unknown as Authed).uid } });
  if (!p.payoutPhone) return s.status(422).json({ error: "Add a payout phone number first." });
  const amt = await available(p.id);
  if (amt < 10) return s.status(409).json({ error: "No available balance to pay out yet." });
  const po = await db.providerPayout.create({ data: { providerId: p.id, amountKes: amt } });
  try {
    const { ok, body } = await b2c(p.payoutPhone, amt, po.id);
    if (!ok || String(body.ResponseCode) !== "0") { await db.providerPayout.update({ where: { id: po.id }, data: { status: "FAILED" } }); return s.status(502).json({ error: "M-Pesa couldn't start the payout. Your balance is unchanged." }); }
    await db.providerPayout.update({ where: { id: po.id }, data: { mpesaConversationId: body.ConversationID } });
    s.status(202).json({ payoutId: po.id, status: "PENDING", amountKes: amt });
  } catch { await db.providerPayout.update({ where: { id: po.id }, data: { status: "FAILED" } }); s.status(502).json({ error: "We couldn't reach M-Pesa. Try again shortly." }); }
});
r.post("/result/:token", async (q, s) => {
  if (q.params.token !== cfg.MPESA_CALLBACK_TOKEN) return s.sendStatus(404);
  try {
    const res = q.body?.Result;
    const po = res && (await db.providerPayout.findFirst({ where: { OR: [{ id: res.OriginatorConversationID }, { mpesaConversationId: res.ConversationID }] }, include: { provider: true } }));
    if (po && po.status === "PENDING") {
      if (res.ResultCode === 0) {
        await db.$transaction([db.providerPayout.update({ where: { id: po.id }, data: { status: "PAID" } }),
          db.ledgerEntry.create({ data: { type: "PROVIDER_PAYOUT", providerId: po.providerId, amountKes: po.amountKes } })]);
        await notify(po.provider.userId, "PAYOUT_SENT", `KES ${po.amountKes} was sent to your M-Pesa.`);
      } else await db.providerPayout.update({ where: { id: po.id }, data: { status: "FAILED" } });
      await audit(null, "PAYOUT_" + (res.ResultCode === 0 ? "PAID" : "FAILED"), "ProviderPayout", po.id, { code: res.ResultCode });
    }
  } catch (e) { console.error(e); }
  s.json({ ResultCode: 0, ResultDesc: "Accepted" });
});
r.post("/timeout/:token", (q, s) => s.json({ ResultCode: 0, ResultDesc: "Accepted" })); // payout stays PENDING until result arrives; reconcile in the M-Pesa portal
export default r;
