// billing.js — Stripe subscriptions. Server-side enforcement only: the webhook
// is the single source of truth that moves a user between tiers. Client-reported
// subscription state is never trusted.
import express from "express";
import Stripe from "stripe";
import { config } from "./config.js";
import { one, query } from "./db.js";
import { authRequired } from "./auth.js";

const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

// Guard: every billing route no-ops cleanly until Stripe is configured.
function requireStripe(req, res, next) {
  if (!stripe) return res.status(503).json({ error: "billing_unconfigured", message: "Stripe is not configured on this server yet." });
  next();
}

export const billingRouter = express.Router();

// Start a Checkout session for a plan. Body: { plan: "lite" | "pro" }.
billingRouter.post("/checkout", requireStripe, authRequired, async (req, res) => {
  const plan = String(req.body?.plan || "").toLowerCase();
  const priceId = config.stripe.prices[plan];
  if (!priceId) return res.status(400).json({ error: "invalid_plan", message: "Plan must be 'lite' or 'pro' and have a configured price." });

  // Reuse or create the Stripe customer for this user.
  let customerId = req.user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: req.user.email, metadata: { user_id: String(req.user.id) } });
    customerId = customer.id;
    await query("UPDATE users SET stripe_customer_id = $1, updated_at = now() WHERE id = $2", [customerId, req.user.id]);
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${config.appBaseUrl}/?billing=success`,
    cancel_url: `${config.appBaseUrl}/?billing=cancelled`,
    metadata: { user_id: String(req.user.id), plan },
  });
  res.json({ url: session.url });
});

// Open the Stripe billing portal (manage/cancel).
billingRouter.post("/portal", requireStripe, authRequired, async (req, res) => {
  if (!req.user.stripe_customer_id) return res.status(400).json({ error: "no_customer" });
  const session = await stripe.billingPortal.sessions.create({
    customer: req.user.stripe_customer_id,
    return_url: config.appBaseUrl,
  });
  res.json({ url: session.url });
});

// Map a Stripe price id back to our tier name.
function tierForPrice(priceId) {
  if (priceId && priceId === config.stripe.prices.pro) return "pro";
  if (priceId && priceId === config.stripe.prices.lite) return "lite";
  return "free";
}

async function syncSubscription(sub) {
  const customerId = sub.customer;
  const user = await one("SELECT * FROM users WHERE stripe_customer_id = $1", [customerId]);
  if (!user) return;
  const priceId = sub.items?.data?.[0]?.price?.id || null;
  const active = ["trialing", "active", "past_due"].includes(sub.status);
  const tier = active ? tierForPrice(priceId) : "free";

  await query(
    `INSERT INTO subscriptions (user_id, stripe_subscription_id, stripe_price_id, tier, status, current_period_end, cancel_at_period_end)
     VALUES ($1,$2,$3,$4,$5,to_timestamp($6),$7)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       stripe_price_id = EXCLUDED.stripe_price_id, tier = EXCLUDED.tier, status = EXCLUDED.status,
       current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end, updated_at = now()`,
    [user.id, sub.id, priceId, tier, sub.status, sub.current_period_end || null, sub.cancel_at_period_end || false]
  );
  await query("UPDATE users SET tier = $1, updated_at = now() WHERE id = $2", [tier, user.id]);
}

// Stripe webhook. MUST receive the raw body — index.js mounts it with
// express.raw before the JSON parser. This is the only path that changes tiers.
export async function stripeWebhookHandler(req, res) {
  if (!stripe) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], config.stripe.webhookSecret);
  } catch (e) {
    return res.status(400).send(`Webhook signature verification failed: ${e.message}`);
  }
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        if (s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          await syncSubscription(sub);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(event.data.object);
        break;
      default:
        break; // ignore the rest
    }
    res.json({ received: true });
  } catch (e) {
    console.error("[billing] webhook handling error:", e);
    res.status(500).json({ error: "webhook_handler_failed" });
  }
}
