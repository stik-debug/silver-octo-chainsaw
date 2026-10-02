import { Router } from "express";
import { z } from "zod";
import { BookingStatus } from "@prisma/client";
import { db, notify } from "../lib/db";
import { requireAuth, Authed } from "../lib/auth";
const r = Router();
r.use(requireAuth());

// Server-enforced state machine: who may move a booking from X to Y.
const T: Record<string, { to: BookingStatus; by: "customer" | "provider" }[]> = {
  REQUESTED: [{ to: "ACCEPTED", by: "provider" }, { to: "DECLINED", by: "provider" }, { to: "CANCELLED", by: "customer" }],
  ACCEPTED: [{ to: "CANCELLED", by: "customer" }],
  QUOTED: [{ to: "QUOTE_ACCEPTED", by: "customer" }, { to: "CANCELLED", by: "customer" }],
  SCHEDULED: [{ to: "PROVIDER_ARRIVED", by: "provider" }],
  PROVIDER_ARRIVED: [{ to: "IN_PROGRESS", by: "provider" }],
  IN_PROGRESS: [{ to: "COMPLETED", by: "provider" }],
  COMPLETED: [{ to: "CONFIRMED", by: "customer" }, { to: "DISPUTED", by: "customer" }],
};
export async function move(id: string, to: BookingStatus, actorId: string | null, data: object = {}) {
  return db.$transaction(async tx => {
    const b = await tx.booking.findUniqueOrThrow({ where: { id } });
    await tx.bookingEvent.create({ data: { bookingId: id, fromStatus: b.status, toStatus: to, actorId } });
    return tx.booking.update({ where: { id }, data: { status: to, ...data } });
  });
}
r.post("/", async (req, res) => {
  const uid = (req as unknown as Authed).uid;
  const b = z.object({ providerId: z.string(), categorySlug: z.string(), description: z.string().min(10).max(2000),
    address: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "Describe the job (min 10 characters)." });
  const prov = await db.providerProfile.findFirst({ where: { id: b.data.providerId, status: "ACTIVE", verification: "VERIFIED" } });
  const cat = await db.serviceCategory.findUnique({ where: { slug: b.data.categorySlug } });
  if (!prov || !cat) return res.status(404).json({ error: "Provider or service not available." });
  if (prov.userId === uid) return res.status(400).json({ error: "You cannot book yourself." });
  const { providerId, categorySlug, ...rest } = b.data;
  const bk = await db.booking.create({ data: { customerId: uid, providerId: prov.id, categoryId: cat.id, ...rest, history: { create: { toStatus: "REQUESTED", actorId: uid } } } });
  await notify(prov.userId, "BOOKING_REQUEST", "You have a new booking request.");
  res.status(201).json(bk);
});
r.get("/", async (req, res) => {
  const uid = (req as unknown as Authed).uid;
  const rows = await db.booking.findMany({ where: { OR: [{ customerId: uid }, { provider: { userId: uid } }] }, include: { payments: { select: { id: true, status: true }, orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { createdAt: "desc" } });
  res.json({ bookings: rows, message: rows.length ? undefined : "You don't have any bookings yet." });
});
r.post("/:id/transition", async (req, res) => {
  const uid = (req as unknown as Authed).uid;
  const to = z.nativeEnum(BookingStatus).safeParse(req.body.to);
  const b = await db.booking.findUnique({ where: { id: req.params.id }, include: { provider: true } });
  if (!to.success || !b) return res.status(400).json({ error: "Invalid request" });
  const side = b.customerId === uid ? "customer" : b.provider.userId === uid ? "provider" : null;
  if (!side || !(T[b.status] || []).some(t => t.to === to.data && t.by === side)) return res.status(409).json({ error: `Cannot move from ${b.status} to ${to.data}.` });
  const nb = await move(b.id, to.data, uid);
  await notify(side === "customer" ? b.provider.userId : b.customerId, "BOOKING_" + to.data, `Booking is now ${to.data.toLowerCase().replace(/_/g, " ")}.`);
  res.json(nb);
});
r.post("/:id/quote", requireAuth("PROVIDER"), async (req, res) => {
  const b = await db.booking.findUnique({ where: { id: req.params.id }, include: { provider: true } });
  const q = z.object({ amountKes: z.number().int().min(10).max(250000), note: z.string().max(1000).optional() }).safeParse(req.body);
  if (!b || b.provider.userId !== (req as unknown as Authed).uid || b.status !== "ACCEPTED" || !q.success) return res.status(409).json({ error: "Cannot quote this booking." });
  const nb = await move(b.id, "QUOTED", (req as unknown as Authed).uid, { quoteKes: q.data.amountKes, quoteNote: q.data.note });
  await notify(b.customerId, "NEW_QUOTE", `New quote: KES ${q.data.amountKes}.`);
  res.json(nb);
});
r.post("/:id/messages", async (req, res) => {
  const uid = (req as unknown as Authed).uid;
  const b = await db.booking.findUnique({ where: { id: req.params.id }, include: { provider: true } });
  const body = z.string().min(1).max(2000).safeParse(req.body.body);
  if (!b || !body.success || ![b.customerId, b.provider.userId].includes(uid)) return res.status(403).json({ error: "Not allowed" });
  const to = uid === b.customerId ? b.provider.userId : b.customerId;
  const m = await db.message.create({ data: { bookingId: b.id, senderId: uid, recipientId: to, body: body.data } });
  await notify(to, "NEW_MESSAGE", "You have a new message.");
  res.status(201).json(m);
});
r.get("/:id/messages", async (req, res) => {
  const uid = (req as unknown as Authed).uid;
  const b = await db.booking.findUnique({ where: { id: req.params.id }, include: { provider: true } });
  if (!b || ![b.customerId, b.provider.userId].includes(uid)) return res.status(403).json({ error: "Not allowed" });
  const ms = await db.message.findMany({ where: { bookingId: b.id }, orderBy: { createdAt: "asc" } });
  res.json({ messages: ms, message: ms.length ? undefined : "No messages yet." });
});
r.post("/:id/review", async (req, res) => {
  const uid = (req as unknown as Authed).uid;
  const v = z.object({ rating: z.number().int().min(1).max(5), text: z.string().max(2000).optional() }).safeParse(req.body);
  const b = await db.booking.findUnique({ where: { id: req.params.id }, include: { review: true } });
  if (!v.success || !b || b.customerId !== uid || b.status !== "CONFIRMED" || b.review) return res.status(409).json({ error: "You can review a confirmed booking once." });
  res.status(201).json(await db.review.create({ data: { bookingId: b.id, customerId: uid, providerId: b.providerId, ...v.data } }));
});
export default r;
