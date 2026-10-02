// Controlled first-admin setup: run once at deploy with ADMIN_PHONE / ADMIN_NAME set. Login is by real OTP; enrol MFA before production use.
import { db, audit } from "./lib/db";
(async () => {
  const phone = process.env.ADMIN_PHONE, name = process.env.ADMIN_NAME;
  if (!phone || !/^254\d{9}$/.test(phone) || !name) throw new Error("Set ADMIN_PHONE (2547XXXXXXXX) and ADMIN_NAME");
  const u = await db.user.upsert({ where: { phone }, update: { role: "ADMIN" }, create: { phone, name, role: "ADMIN", termsAcceptedAt: new Date(), privacyConsentAt: new Date() } });
  await audit(null, "ADMIN_CREATED", "User", u.id);
  console.log("Admin ready:", u.id);
})().finally(() => db.$disconnect());
