import { z } from "zod";
const s = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  M_PESA_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  MPESA_CONSUMER_KEY: z.string().default(""), MPESA_CONSUMER_SECRET: z.string().default(""),
  MPESA_SHORTCODE: z.string().default(""), MPESA_PASSKEY: z.string().default(""),
  MPESA_CALLBACK_URL: z.string().default(""), MPESA_CALLBACK_TOKEN: z.string().default(""),
  AT_USERNAME: z.string().default(""), AT_API_KEY: z.string().default(""), AT_SENDER_ID: z.string().default(""),
  PUBLIC_URL: z.string().default(""), MPESA_INITIATOR_NAME: z.string().default(""), MPESA_SECURITY_CREDENTIAL: z.string().default(""),
  S3_BUCKET: z.string().default(""), S3_REGION: z.string().default("auto"), S3_ENDPOINT: z.string().default(""),
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(50).default(10),
});
export const cfg = s.parse(process.env);
if (cfg.NODE_ENV === "production") {
  if (cfg.M_PESA_ENV !== "production") throw new Error("Production refuses sandbox M-Pesa config");
  if (/localhost|_dev|_test/.test(cfg.DATABASE_URL)) throw new Error("Production refuses a development database");
  for (const k of ["MPESA_CONSUMER_KEY","MPESA_CONSUMER_SECRET","MPESA_SHORTCODE","MPESA_PASSKEY","MPESA_CALLBACK_TOKEN","AT_API_KEY"] as const)
    if (!cfg[k]) throw new Error(`Missing required production secret: ${k}`);
}
