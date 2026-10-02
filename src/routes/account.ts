import { Router } from "express";
import { z } from "zod";
import { authenticator } from "otplib";
import { db, audit, notify } from "../lib/db";
import { requireAuth, Authed } from "../lib/auth";
import { reverse } from "../lib/mpesa";
import { cfg } from "../config";
const r = Router();
const uid = (q: any) => (q as unknown as Authed).uid;

// --- Admin MFA (TOTP) ---
r.post("/mfa/setup", requireAuth("ADMIN_ENROL", "ADMIN"), async (q, s) => {
  const secret = authenticator.generateSecret();
  await db.user.update({ where: { id: uid(q) }, data: { mfaSecret: secret, mfaEnabled: false } });
  s.json({ otpauthUrl: authenticator.keyuri(uid(q), "MtaaPro", secret), secret });
});
r.post("/mfa/confirm", requireAuth("ADMIN_ENROL", "ADMIN"), async (q, s) => {
  const u = await db.user.findUniqueOrThrow({ where: { id: uid(q) } });
  if (!u.mfaSecret || !authenticator.check(String(q.body.code || ""), u.mfaSecret)) return s.status(400).json({ error: "Incorrect code" });
  await db.user.update({ where: { id: u.id }, data: { mfaEnabled: true } });
  await audit(u.id, "MFA_ENABLED", "User", u.id);
  s.json({ ok: true, message: "MFA enabled. Log in again with your authenticator code." });
});

// --- Data access / deletion (Kenya DPA rights) ---
r.get("/export", requireAuth(), async (q, s) => {
  const id = uid(q);
  const [user, provider, bookings, messages, reviews, notifications, tickets] = await Promise.all([
    db.user.findUnique({ where: { id }, select: { id: true, phone: true, name: true, role: true, area: true, createdAt: true, termsAcceptedAt: true, privacyConsentAt: true } }),
    db.providerProfile.findUnique({ where: { userId: id } }),
    db.booking.findMany({ where: { OR: [{ customerId: id }, { provider: { userId: id } }] } }),
    db.message.findMany({ where: { OR: [{ senderId: id }, { recipientId: id }] } }),
    db.review.findMany({ where: { customerId: id } }), db.notification.findMany({ where: { userId: id } }), db.supportTicket.findMany({ where: { userId: id } }),
  ]);
  await audit(id, "DATA_EXPORT", "User", id);
  s.json({ user, provider, bookings, messages, reviews, notifications, tickets });
});
r.delete("/", requireAuth("CUSTOMER", "PROVIDER"), async (q, s) => {
  const id = uid(q);
  const open = await db.booking.count({ where: { OR: [{ customerId: id }, { provider: { userId: id } }], status: { notIn: ["CONFIRMED", "CANCELLED", "DECLINED"] } } });
  if (open) return s.status(409).json({ error: "Finish or cancel your open bookings before closing your account." });
  // Anonymise personal data; financial ledger rows are retained for legal/accounting reasons.
  await db.$transaction([
    db.user.update({ where: { id }, data: { name: "Deleted user", phone: `deleted-${id}`, photoKey: null, area: null, deletedAt: new Date() } }),
    db.session.updateMany({ where: { userId: id }, data: { revokedAt: new Date() } }),
    db.providerProfile.updateMany({ where: { userId: id }, data: { legalName: "Deleted", bio: null, payoutPhone: null, available: false, lat: null, lng: null } }),
    db.providerDocument.deleteMany({ where: { provider: { userId: id } } }),
  ]);
  await audit(id, "ACCOUNT_DELETED", "User", id);
  s.json({ ok: true });
});

// --- Support tickets & disputes ---
r.post("/tickets", requireAuth(), async (q, s) => {
  const b = z.object({ subject: z.string().min(3).max(200), body: z.string().min(10).max(4000) }).safeParse(q.body);
  if (!b.success) return s.status(400).json({ error: "Add a subject and describe the issue." });
  s.status(201).json(await db.supportTicket.create({ data: { userId: uid(q), ...b.data } }));
});
r.get("/tickets", requireAuth(), async (q, s) => s.json(await db.supportTicket.findMany({ where: { userId: uid(q) }, orderBy: { createdAt: "desc" } })));
r.post("/disputes", requireAuth(), async (q, s) => {
  const b = z.object({ bookingId: z.string(), reason: z.string().min(10).max(4000) }).safeParse(q.body);
  const bk = b.success ? await db.booking.findUnique({ where: { id: b.data.bookingId } }) : null;
  if (!b.success || !bk || bk.customerId !== uid(q) || bk.status !== "COMPLETED") return s.status(409).json({ error: "You can dispute a booking once the provider marks it completed." });
  const [d] = await db.$transaction([
    db.dispute.create({ data: { bookingId: bk.id, openedById: uid(q), reason: b.data.reason } }),
    db.booking.update({ where: { id: bk.id }, data: { status: "DISPUTED" } }),
    db.bookingEvent.create({ data: { bookingId: bk.id, fromStatus: "COMPLETED", toStatus: "DISPUTED", actorId: uid(q) } }),
  ]);
  s.status(201).json(d);
});
r.get("/admin/queue", requireAuth("ADMIN"), async (_q, s) => s.json({
  tickets: await db.supportTicket.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "asc" } }),
  disputes: await db.dispute.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "asc" } }) }));
r.post("/admin/tickets/:id/close", requireAuth("ADMIN"), async (q, s) => { await db.supportTicket.update({ where: { id: q.params.id }, data: { status: "CLOSED" } }); await audit(uid(q), "TICKET_CLOSED", "SupportTicket", q.params.id); s.json({ ok: true }); });
// RELEASE = provider was right (booking confirmed); REFUND = customer was right (booking cancelled, refund ledger entry; send the money back via Daraja reversal in the M-Pesa portal).
r.post("/admin/disputes/:id/resolve", requireAuth("ADMIN"), async (q, s) => {
  const b = z.object({ outcome: z.enum(["RELEASE", "REFUND"]), note: z.string().optional() }).safeParse(q.body);
  const d = await db.dispute.findUnique({ where: { id: q.params.id } });
  if (!b.success || !d || d.status !== "OPEN") return s.status(409).json({ error: "Cannot resolve." });
  const bk = await db.booking.findUniqueOrThrow({ where: { id: d.bookingId }, include: { provider: true, payments: { where: { status: "CONFIRMED" } } } });
  const ops: any[] = [
    db.dispute.update({ where: { id: d.id }, data: { status: "RESOLVED", resolution: `${b.data.outcome}: ${b.data.note ?? ""}` } }),
    db.booking.update({ where: { id: bk.id }, data: { status: b.data.outcome === "RELEASE" ? "CONFIRMED" : "CANCELLED" } }),
    db.bookingEvent.create({ data: { bookingId: bk.id, fromStatus: "DISPUTED", toStatus: b.data.outcome === "RELEASE" ? "CONFIRMED" : "CANCELLED", actorId: uid(q) } }),
  ];
  if (b.data.outcome === "REFUND" && bk.payments[0]) {
    const p = bk.payments[0];
    ops.push(db.ledgerEntry.create({ data: { type: "REFUND", paymentId: p.id, bookingId: bk.id, providerId: bk.providerId, amountKes: p.amountKes } }));
    // reverse the provider's earning so balances stay correct
    const earn = await db.ledgerEntry.findFirst({ where: { paymentId: p.id, type: "PROVIDER_EARNING" } });
    if (earn) ops.push(db.ledgerEntry.update({ where: { id: earn.id }, data: { amountKes: 0 } }));
  }
  await db.$transaction(ops);
  // Automatic Daraja reversal when initiator credentials are configured; otherwise the admin reverses manually in the Daraja portal.
  let reversal = "MANUAL";
  if (b.data.outcome === "REFUND" && bk.payments[0]?.mpesaReceipt && cfg.MPESA_INITIATOR_NAME && cfg.MPESA_SECURITY_CREDENTIAL && cfg.PUBLIC_URL) {
    try { const rv = await reverse(bk.payments[0].mpesaReceipt, bk.payments[0].amountKes);
      await db.paymentEvent.create({ data: { paymentId: bk.payments[0].id, source: "reversal_request", payload: rv.body } });
      reversal = rv.ok ? "REQUESTED" : "FAILED_MANUAL_REQUIRED"; } catch { reversal = "FAILED_MANUAL_REQUIRED"; }
  }
  await audit(uid(q), "DISPUTE_" + b.data.outcome, "Dispute", d.id, { note: b.data.note });
  await notify(bk.customerId, "DISPUTE_RESOLVED", "Your dispute was resolved."); await notify(bk.provider.userId, "DISPUTE_RESOLVED", "A dispute on your job was resolved.");
  s.json({ ok: true, reversal });
});
export default r;
