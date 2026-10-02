import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { cfg } from "./config";
import auth from "./routes/auth";
import providers from "./routes/providers";
import bookings from "./routes/bookings";
import payments from "./routes/payments";
import admin from "./routes/admin";
import path from "path";
import account from "./routes/account";
import uploads from "./routes/uploads";
import payouts from "./routes/payouts";
import jwt from "jsonwebtoken";
import * as Sentry from "@sentry/node";
import { bus } from "./lib/events";
import { db } from "./lib/db";
import { requireAuth, Authed } from "./lib/auth";
if (process.env.SENTRY_DSN) Sentry.init({ dsn: process.env.SENTRY_DSN, environment: cfg.NODE_ENV });
export const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", "https://cdnjs.cloudflare.com"], styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
  imgSrc: ["'self'", "data:", "blob:", "https:"], connectSrc: ["'self'", "https:"], workerSrc: ["'self'", "blob:"], childSrc: ["blob:"], fontSrc: ["'self'", "data:", "https:"] } } }));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60e3, limit: 120 }));
app.get("/health", async (_q, r) => { try { await db.$queryRaw`SELECT 1`; r.json({ ok: true }); } catch { r.status(503).json({ ok: false }); } });
// Server-sent events: live notifications/messages. EventSource can't set headers, so the access token is a query param.
app.get("/api/stream", (q, r) => {
  let uid: string;
  try { uid = (jwt.verify(String(q.query.token), cfg.JWT_SECRET) as any).sub; } catch { return void r.sendStatus(401); }
  r.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }); r.flushHeaders();
  const on = (n: any) => r.write(`data: ${JSON.stringify({ kind: n.kind, body: n.body })}\n\n`);
  bus.on(uid, on);
  const hb = setInterval(() => r.write(":hb\n\n"), 25000);
  q.on("close", () => { clearInterval(hb); bus.off(uid, on); });
});
app.get("/api/categories", async (_q, r) => r.json(await db.serviceCategory.findMany({ orderBy: { name: "asc" } })));
app.get("/api/notifications", requireAuth(), async (q, r) => {
  const n = await db.notification.findMany({ where: { userId: (q as unknown as Authed).uid }, orderBy: { createdAt: "desc" }, take: 50 });
  r.json({ notifications: n, message: n.length ? undefined : "You're all caught up." });
});
app.use("/api/auth", auth);
app.use("/api/providers", providers);
app.use("/api/bookings", bookings);
app.use("/api/payments", payments);
app.use("/api/admin", admin);
app.use("/api/account", account);
app.use("/api/uploads", uploads);
app.use("/api/payouts", payouts);
app.use(express.static(path.join(__dirname, "..", "public")));
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);
app.use((e: Error, _q: express.Request, r: express.Response, _n: express.NextFunction) => { console.error(e); r.status(500).json({ error: "Something went wrong." }); });
