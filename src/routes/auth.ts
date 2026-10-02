import { Router } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { z } from "zod";
import { db, audit } from "../lib/db";
import { sha, signAccess, newSession } from "../lib/auth";
import { sendSms } from "../lib/sms";
import { authenticator } from "otplib";
const r = Router();
const lim = rateLimit({ windowMs: 15 * 60e3, limit: 10 });
const phone = z.string().regex(/^254[17]\d{8}$/, "Use format 2547XXXXXXXX");

r.post("/request-otp", lim, async (req, res) => {
  const p = z.object({ phone }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0].message });
  const recent = await db.otpCode.count({ where: { phone: p.data.phone, createdAt: { gt: new Date(Date.now() - 10 * 60e3) } } });
  if (recent >= 3) return res.status(429).json({ error: "Too many codes requested. Try again later." });
  const code = String(crypto.randomInt(100000, 1000000));
  await db.otpCode.create({ data: { phone: p.data.phone, codeHash: sha(code + p.data.phone), expiresAt: new Date(Date.now() + 5 * 60e3) } });
  try { await sendSms(p.data.phone, `Your MtaaPro code is ${code}. It expires in 5 minutes.`); }
  catch { return res.status(502).json({ error: "We couldn't send the SMS. Please try again." }); }
  res.json({ ok: true });
});

r.post("/verify-otp", lim, async (req, res) => {
  const p = z.object({ phone, code: z.string().length(6), name: z.string().min(2).optional(),
    totp: z.string().optional(), acceptTerms: z.boolean().optional(), privacyConsent: z.boolean().optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Invalid input" });
  const otp = await db.otpCode.findFirst({ where: { phone: p.data.phone, consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
  if (!otp || otp.attempts >= 5) return res.status(400).json({ error: "Code expired or too many attempts. Request a new one." });
  if (otp.codeHash !== sha(p.data.code + p.data.phone)) {
    await db.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    return res.status(400).json({ error: "Incorrect code" });
  }
  await db.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
  let user = await db.user.findUnique({ where: { phone: p.data.phone } });
  if (!user) {
    if (!p.data.name || !p.data.acceptTerms || !p.data.privacyConsent)
      return res.status(422).json({ error: "New accounts need name, terms acceptance and privacy consent." });
    user = await db.user.create({ data: { phone: p.data.phone, name: p.data.name, termsAcceptedAt: new Date(), privacyConsentAt: new Date() } });
    await audit(user.id, "USER_REGISTERED", "User", user.id);
  }
  if (user.deletedAt) return res.status(403).json({ error: "Account closed" });
  if (user.role === "ADMIN") {
    if (!user.mfaEnabled) return res.json({ accessToken: signAccess(user.id, "ADMIN_ENROL"), mfaEnrolmentRequired: true });
    if (!p.data.totp || !authenticator.check(p.data.totp, user.mfaSecret!)) return res.status(401).json({ error: "Authenticator code required." });
  }
  res.json({ accessToken: signAccess(user.id, user.role), refreshToken: await newSession(user.id, req.headers["user-agent"]), user: { id: user.id, name: user.name, role: user.role } });
});

r.post("/refresh", async (req, res) => {
  const s = await db.session.findUnique({ where: { refreshHash: sha(String(req.body.refreshToken || "")) }, include: { user: true } });
  if (!s || s.revokedAt || s.expiresAt < new Date()) return res.status(401).json({ error: "Session expired" });
  res.json({ accessToken: signAccess(s.userId, s.user.role) });
});
r.post("/logout", async (req, res) => {
  await db.session.updateMany({ where: { refreshHash: sha(String(req.body.refreshToken || "")) }, data: { revokedAt: new Date() } });
  res.json({ ok: true });
});
export default r;
