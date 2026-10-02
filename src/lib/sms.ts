import { cfg } from "../config";
// Real SMS via Africa's Talking. In development only, with no key set, the OTP is logged to the server console (never returned to the client).
export async function sendSms(to: string, message: string) {
  if (!cfg.AT_API_KEY) {
    if (cfg.NODE_ENV === "development") { console.log(`[DEV SMS to ${to}] ${message}`); return; }
    throw new Error("SMS provider not configured");
  }
  const host = cfg.AT_USERNAME === "sandbox" ? "api.sandbox.africastalking.com" : "api.africastalking.com";
  const r = await fetch(`https://${host}/version1/messaging`, {
    method: "POST",
    headers: { apiKey: cfg.AT_API_KEY, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: cfg.AT_USERNAME, to: "+" + to, message, ...(cfg.AT_SENDER_ID && { from: cfg.AT_SENDER_ID }) }),
  });
  if (!r.ok) throw new Error(`SMS failed: ${r.status}`);
}
