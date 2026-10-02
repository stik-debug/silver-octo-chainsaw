import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
const r = Router();
// Every number is a live DB aggregate; an empty DB returns zeros.
r.get("/stats", requireAuth("ADMIN"), async (_q, res) => {
  const [users, verified, pending, bookings, completed, cancelled, disputes, gross, fees] = await Promise.all([
    db.user.count(), db.providerProfile.count({ where: { verification: "VERIFIED" } }),
    db.providerProfile.count({ where: { verification: { in: ["PENDING", "UNDER_REVIEW"] } } }),
    db.booking.count(), db.booking.count({ where: { status: "CONFIRMED" } }), db.booking.count({ where: { status: "CANCELLED" } }),
    db.booking.count({ where: { status: "DISPUTED" } }),
    db.ledgerEntry.aggregate({ where: { type: "CUSTOMER_PAYMENT" }, _sum: { amountKes: true } }),
    db.ledgerEntry.aggregate({ where: { type: "PLATFORM_FEE" }, _sum: { amountKes: true } }),
  ]);
  res.json({ users, verifiedProviders: verified, pendingVerifications: pending, bookings, completedBookings: completed, cancelledBookings: cancelled,
    disputes, grossVolumeKes: gross._sum.amountKes ?? 0, platformFeesKes: fees._sum.amountKes ?? 0 });
});
export default r;
