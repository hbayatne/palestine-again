// config.js — environment configuration. Nothing secret is committed; every
// value comes from the environment (see .env.example). The server boots for
// local development without Stripe configured, logging a warning; billing
// endpoints then return 503 until the keys are present.
import "dotenv/config";

const {
  PORT = "8080",
  NODE_ENV = "development",
  DATABASE_URL,
  JWT_SECRET,
  CORS_ORIGIN = "*",
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_LITE,
  STRIPE_PRICE_PRO,
  APP_BASE_URL = "http://localhost:8080",
  FMP_API_KEY = "",
} = process.env;

export const config = {
  port: Number(PORT),
  env: NODE_ENV,
  isProd: NODE_ENV === "production",
  databaseUrl: DATABASE_URL,
  jwtSecret: JWT_SECRET,
  corsOrigin: CORS_ORIGIN,
  appBaseUrl: APP_BASE_URL,
  fmpApiKey: FMP_API_KEY,
  stripe: {
    secretKey: STRIPE_SECRET_KEY,
    webhookSecret: STRIPE_WEBHOOK_SECRET,
    prices: { lite: STRIPE_PRICE_LITE, pro: STRIPE_PRICE_PRO },
    configured: Boolean(STRIPE_SECRET_KEY),
  },
};

// Fail fast on the two things the server genuinely cannot run without.
export function assertCriticalConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push("DATABASE_URL");
  if (!config.jwtSecret || config.jwtSecret.length < 16) missing.push("JWT_SECRET (>=16 chars)");
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
  }
  if (!config.stripe.configured) {
    console.warn("[config] STRIPE_SECRET_KEY not set — billing endpoints will return 503 until configured.");
  }
}
