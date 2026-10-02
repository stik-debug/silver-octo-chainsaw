import { Router } from "express";
import crypto from "crypto";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { cfg } from "../config";
import { db } from "../lib/db";
import { requireAuth, Authed } from "../lib/auth";
const r = Router();
const s3 = new S3Client({ region: cfg.S3_REGION, ...(cfg.S3_ENDPOINT && { endpoint: cfg.S3_ENDPOINT }) }); // creds via AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" };

// Private bucket only. Client PUTs the file to the returned URL, then registers the key via /api/providers/me/documents.
r.post("/presign", requireAuth(), async (q, s) => {
  const ct = String(q.body.contentType || "");
  if (!TYPES[ct]) return s.status(400).json({ error: "Only JPG, PNG or PDF files are allowed." });
  if (!cfg.S3_BUCKET) return s.status(503).json({ error: "File storage isn't configured." });
  const key = `u/${(q as unknown as Authed).uid}/${crypto.randomUUID()}.${TYPES[ct]}`;
  // Presigned POST lets the storage layer enforce a 5 MB cap and the exact content type.
  const post = await createPresignedPost(s3, { Bucket: cfg.S3_BUCKET, Key: key, Expires: 300, Fields: { "Content-Type": ct },
    Conditions: [["content-length-range", 1, 5 * 1024 * 1024], ["eq", "$Content-Type", ct]] });
  s.json({ url: post.url, fields: post.fields, key });
});
// Admin-only, short-lived read link for verification documents.
r.get("/documents/:id/view", requireAuth("ADMIN"), async (q, s) => {
  const d = await db.providerDocument.findUnique({ where: { id: q.params.id } });
  if (!d) return s.sendStatus(404);
  s.json({ url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: d.storageKey }), { expiresIn: 60 }) });
});
export default r;
