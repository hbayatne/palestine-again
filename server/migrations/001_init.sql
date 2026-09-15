-- 001_init.sql — initial schema for the SignalDesk backend.
-- Idempotent: safe to run repeatedly (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  tier          TEXT NOT NULL DEFAULT 'free',      -- free | lite | pro (source of truth for entitlements)
  stripe_customer_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id);

-- One row per Stripe subscription; users.tier is derived from the active one.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      BIGSERIAL PRIMARY KEY,
  user_id                 BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stripe_subscription_id  TEXT UNIQUE NOT NULL,
  stripe_price_id         TEXT,
  tier                    TEXT NOT NULL,
  status                  TEXT NOT NULL,            -- trialing | active | past_due | canceled | ...
  current_period_end      TIMESTAMPTZ,
  cancel_at_period_end    BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions (user_id);

-- The long-term moat: every signal the platform emits, recorded immutably at
-- the time it occurred, so forward outcomes can be measured later. Never
-- rewrite history — only append and, separately, fill in realized returns.
CREATE TABLE IF NOT EXISTS signal_history (
  id            BIGSERIAL PRIMARY KEY,
  symbol        TEXT NOT NULL,
  asset_class   TEXT,
  timeframe     TEXT NOT NULL,
  signal_type   TEXT NOT NULL,           -- e.g. composite | rsi_divergence | accumulation
  direction     TEXT,                    -- bullish | bearish | neutral
  score         NUMERIC,
  strength      NUMERIC,
  confidence    NUMERIC,
  regime        TEXT,
  price_at      NUMERIC NOT NULL,
  inputs        JSONB,                   -- provenance: params, indicator values
  algo_version  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- forward returns, filled in by a later job (nullable until measured)
  ret_1d NUMERIC, ret_5d NUMERIC, ret_10d NUMERIC, ret_20d NUMERIC, ret_60d NUMERIC
);
CREATE INDEX IF NOT EXISTS idx_sig_symbol_time ON signal_history (symbol, created_at);
CREATE INDEX IF NOT EXISTS idx_sig_type ON signal_history (signal_type, direction);

-- Smart alerts (evaluated by a background job; delivery is a later increment).
CREATE TABLE IF NOT EXISTS alerts (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL,
  rule         JSONB NOT NULL,           -- parsed, deterministic criteria
  description  TEXT,
  active       BOOLEAN NOT NULL DEFAULT true,
  last_triggered_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts (user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts (active) WHERE active;
