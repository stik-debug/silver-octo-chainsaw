import { app } from "./app";
import { cfg } from "./config";
app.listen(cfg.PORT, () => console.log(`MtaaPro API on :${cfg.PORT} (${cfg.NODE_ENV}, mpesa=${cfg.M_PESA_ENV})`));
