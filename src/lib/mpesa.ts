import { cfg } from "../config";
const base = () => (cfg.M_PESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke");
let tok: { v: string; exp: number } | null = null;
async function token() {
  if (tok && tok.exp > Date.now()) return tok.v;
  const basic = Buffer.from(`${cfg.MPESA_CONSUMER_KEY}:${cfg.MPESA_CONSUMER_SECRET}`).toString("base64");
  const r = await fetch(`${base()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` } });
  if (!r.ok) throw new Error(`Daraja auth failed: ${r.status}`);
  const j: any = await r.json();
  tok = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) - 60) * 1000 };
  return tok.v;
}
const ts = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const pw = (t: string) => Buffer.from(cfg.MPESA_SHORTCODE + cfg.MPESA_PASSKEY + t).toString("base64");
export async function stkPush(phone: string, amount: number, ref: string) {
  const t = ts();
  const r = await fetch(`${base()}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ BusinessShortCode: cfg.MPESA_SHORTCODE, Password: pw(t), Timestamp: t, TransactionType: "CustomerPayBillOnline",
      Amount: amount, PartyA: phone, PartyB: cfg.MPESA_SHORTCODE, PhoneNumber: phone, CallBackURL: cfg.MPESA_CALLBACK_URL,
      AccountReference: ref.slice(0, 12), TransactionDesc: "MtaaPro booking" }),
  });
  return { ok: r.ok, body: (await r.json()) as any };
}
export async function stkQuery(checkoutRequestId: string) {
  const t = ts();
  const r = await fetch(`${base()}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ BusinessShortCode: cfg.MPESA_SHORTCODE, Password: pw(t), Timestamp: t, CheckoutRequestID: checkoutRequestId }),
  });
  return (await r.json()) as any;
}

export async function b2c(phone: string, amount: number, remarks: string) {
  const r = await fetch(`${base()}/mpesa/b2c/v3/paymentrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ OriginatorConversationID: remarks, InitiatorName: cfg.MPESA_INITIATOR_NAME, SecurityCredential: cfg.MPESA_SECURITY_CREDENTIAL,
      CommandID: "BusinessPayment", Amount: amount, PartyA: cfg.MPESA_SHORTCODE, PartyB: phone, Remarks: "MtaaPro payout", Occassion: "",
      QueueTimeOutURL: `${cfg.PUBLIC_URL}/api/payouts/timeout/${cfg.MPESA_CALLBACK_TOKEN}`, ResultURL: `${cfg.PUBLIC_URL}/api/payouts/result/${cfg.MPESA_CALLBACK_TOKEN}` }),
  });
  return { ok: r.ok, body: (await r.json()) as any };
}
export async function reverse(receipt: string, amount: number) {
  const r = await fetch(`${base()}/mpesa/reversal/v1/request`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ Initiator: cfg.MPESA_INITIATOR_NAME, SecurityCredential: cfg.MPESA_SECURITY_CREDENTIAL, CommandID: "TransactionReversal",
      TransactionID: receipt, Amount: amount, ReceiverParty: cfg.MPESA_SHORTCODE, RecieverIdentifierType: "11", Remarks: "MtaaPro refund", Occasion: "",
      ResultURL: `${cfg.PUBLIC_URL}/api/payments/mpesa/reversal-result/${cfg.MPESA_CALLBACK_TOKEN}`, QueueTimeOutURL: `${cfg.PUBLIC_URL}/api/payments/mpesa/reversal-result/${cfg.MPESA_CALLBACK_TOKEN}` }),
  });
  return { ok: r.ok, body: (await r.json()) as any };
}
