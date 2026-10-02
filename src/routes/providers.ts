import { Router } from "express";
import { z } from "zod";
import { db, audit, notify } from "../lib/db";
import { requireAuth, Authed } from "../lib/auth";
const r = Router();
const km = (a: number, b: number, c: number, d: number) => {
  const R = 6371, t = (x: number) => (x * Math.PI) / 180, dl = t(c - a), dg = t(d - b);
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dg / 2) ** 2));
};

// Public search: ONLY verified + active + available providers, straight from the DB.
r.get("/search", async (req, res) => {
  const q = z.object({ category: z.string(), lat: z.coerce.number(), lng: z.coerce.number(), radiusKm: z.coerce.number().max(50).default(5) }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "category, lat, lng required. Enable location or choose an area." });
  const rows = await db.providerProfile.findMany({
    where: { status: "ACTIVE", verification: "VERIFIED", available: true, lat: { not: null }, services: { some: { category: { slug: q.data.category } } } },
    include: { user: { select: { name: true, photoKey: true } }, reviews: { select: { rating: true } }, services: { include: { category: true } } },
  });
  const out = rows.map(p => ({ p, d: km(q.data.lat, q.data.lng, p.lat!, p.lng!) }))
    .filter(x => x.d <= Math.min(q.data.radiusKm, x.p.serviceRadiusKm)).sort((a, b) => a.d - b.d)
    .map(({ p, d }) => ({
      id: p.id, name: p.user.name, photoKey: p.user.photoKey, bio: p.bio, experienceYears: p.experienceYears,
      services: p.services.map(s => ({ category: s.category.name, baseRateKes: s.baseRateKes })),
      distanceKm: Math.round(d * 10) / 10, // approximate only; exact home location is never exposed
      reviewCount: p.reviews.length,
      rating: p.reviews.length ? Math.round((p.reviews.reduce((a, b) => a + b.rating, 0) / p.reviews.length) * 10) / 10 : null,
      verified: true,
      approx: { lat: Math.round(p.lat! * 100) / 100, lng: Math.round(p.lng! * 100) / 100 }, // ~1 km grid, never the exact base
    }));
  res.json({ providers: out, message: out.length ? undefined : "No verified providers available in this area yet." });
});

r.post("/me", requireAuth("CUSTOMER", "PROVIDER"), async (req, res) => {
  const uid = (req as unknown as Authed).uid;
  const b = z.object({ legalName: z.string().min(3), bio: z.string().max(1000).optional(), experienceYears: z.number().int().min(0).max(60),
    categorySlugs: z.array(z.string()).min(1), lat: z.number(), lng: z.number(), serviceRadiusKm: z.number().min(1).max(50),
    payoutPhone: z.string().regex(/^254\d{9}$/) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "Invalid profile", details: b.error.issues });
  const { categorySlugs, ...rest } = b.data;
  const cats = await db.serviceCategory.findMany({ where: { slug: { in: categorySlugs } } });
  if (!cats.length) return res.status(400).json({ error: "Unknown service category." });
  const p = await db.providerProfile.upsert({
    where: { userId: uid }, update: { ...rest },
    create: { userId: uid, ...rest, status: "PROFILE_COMPLETED", services: { create: cats.map(c => ({ categoryId: c.id })) } },
  });
  await db.user.update({ where: { id: uid }, data: { role: "PROVIDER" } });
  await audit(uid, "PROVIDER_PROFILE_SAVED", "ProviderProfile", p.id);
  res.json({ id: p.id, status: p.status });
});
// Document keys come from your object-storage presigned upload flow (README); only the private key is stored.
r.post("/me/documents", requireAuth("PROVIDER"), async (req, res) => {
  const b = z.object({ kind: z.enum(["NATIONAL_ID", "PASSPORT", "GOOD_CONDUCT", "TRADE_CERT"]), storageKey: z.string().min(5) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "Invalid document" });
  const p = await db.providerProfile.findUniqueOrThrow({ where: { userId: (req as unknown as Authed).uid } });
  await db.providerDocument.create({ data: { providerId: p.id, ...b.data } });
  res.json({ ok: true });
});
r.post("/me/submit-verification", requireAuth("PROVIDER"), async (req, res) => {
  const p = await db.providerProfile.findUniqueOrThrow({ where: { userId: (req as unknown as Authed).uid }, include: { documents: true } });
  if (!p.documents.length) return res.status(422).json({ error: "Upload at least one verification document first." });
  await db.$transaction([
    db.providerProfile.update({ where: { id: p.id }, data: { status: "VERIFICATION_PENDING", verification: "PENDING" } }),
    db.verificationRecord.create({ data: { providerId: p.id, status: "PENDING" } }),
  ]);
  res.json({ status: "PENDING" });
});
r.patch("/me/availability", requireAuth("PROVIDER"), async (req, res) => {
  const p = await db.providerProfile.findUniqueOrThrow({ where: { userId: (req as unknown as Authed).uid } });
  if (p.verification !== "VERIFIED") return res.status(403).json({ error: "Only verified providers can go available." });
  await db.providerProfile.update({ where: { id: p.id }, data: { available: !!req.body.available, status: "ACTIVE" } });
  res.json({ ok: true });
});
r.get("/admin/pending", requireAuth("ADMIN"), async (_q, res) =>
  res.json(await db.providerProfile.findMany({ where: { verification: { in: ["PENDING", "UNDER_REVIEW"] } }, include: { documents: true, user: true } })));
r.post("/admin/:id/review", requireAuth("ADMIN"), async (req, res) => {
  const b = z.object({ decision: z.enum(["VERIFIED", "REJECTED", "SUSPENDED"]), note: z.string().optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "Invalid decision" });
  const admin = (req as unknown as Authed).uid;
  const p = await db.providerProfile.update({ where: { id: req.params.id }, data: {
    verification: b.data.decision, verifiedAt: b.data.decision === "VERIFIED" ? new Date() : null, available: false,
    status: b.data.decision === "VERIFIED" ? "VERIFIED" : b.data.decision === "SUSPENDED" ? "SUSPENDED" : "PROFILE_COMPLETED" } });
  await db.verificationRecord.create({ data: { providerId: p.id, status: b.data.decision, reviewerId: admin, note: b.data.note } });
  await audit(admin, "VERIFICATION_" + b.data.decision, "ProviderProfile", p.id, { note: b.data.note });
  await notify(p.userId, "VERIFICATION", `Your verification was ${b.data.decision.toLowerCase()}.`);
  res.json({ ok: true });
});
export default r;
