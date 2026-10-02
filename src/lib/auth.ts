import jwt from "jsonwebtoken";
import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { cfg } from "../config";
import { db } from "./db";
export const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const signAccess = (id: string, role: string) => jwt.sign({ sub: id, role }, cfg.JWT_SECRET, { expiresIn: "15m" });
export async function newSession(userId: string, device?: string) {
  const refresh = crypto.randomBytes(48).toString("hex");
  await db.session.create({ data: { userId, refreshHash: sha(refresh), device, expiresAt: new Date(Date.now() + 30 * 864e5) } });
  return refresh;
}
export type Authed = Request & { uid: string; role: string };
export const requireAuth = (...roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const t = (req.headers.authorization || "").replace("Bearer ", "");
    const p = jwt.verify(t, cfg.JWT_SECRET) as any;
    if (p.role === "ADMIN_ENROL" && !roles.includes("ADMIN_ENROL")) return res.status(403).json({ error: "Finish MFA enrolment first." });
    if (roles.length && !roles.includes(p.role)) return res.status(403).json({ error: "Forbidden" });
    (req as unknown as Authed).uid = p.sub; (req as unknown as Authed).role = p.role; next();
  } catch { res.status(401).json({ error: "Not authenticated" }); }
};
