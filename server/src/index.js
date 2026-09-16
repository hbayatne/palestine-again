// index.js — SignalDesk backend entrypoint.
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config, assertCriticalConfig } from "./config.js";
import { runMigrations } from "./migrate.js";
import { authRouter } from "./auth.js";
import { billingRouter, stripeWebhookHandler } from "./billing.js";
import { dataRouter } from "./marketData.js";

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map((s) => s.trim()) }));

// Stripe webhook needs the RAW body for signature verification — mount it
// BEFORE the JSON parser, on its own raw route.
app.post("/billing/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);

// Everything else is JSON.
app.use(express.json({ limit: "256kb" }));

// Basic abuse protection on auth + data.
app.use("/auth", rateLimit({ windowMs: 15 * 60_000, max: 50 }));
app.use("/api", rateLimit({ windowMs: 60_000, max: 120 }));

app.get("/health", (_req, res) => res.json({ ok: true, env: config.env, time: new Date().toISOString() }));

app.use("/auth", authRouter);
app.use("/billing", billingRouter);
app.use("/api", dataRouter);

// Fallback error handler.
app.use((err, _req, res, _next) => {
  console.error("[error]", err);
  res.status(500).json({ error: "internal_error" });
});

async function start() {
  assertCriticalConfig();
  await runMigrations();
  app.listen(config.port, () => console.log(`[signaldesk-server] listening on :${config.port} (${config.env})`));
}

start().catch((e) => {
  console.error("[fatal]", e.message);
  process.exit(1);
});

export { app };
