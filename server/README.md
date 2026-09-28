# SignalDesk Backend

The API that turns SignalDesk from a client-only demo into an enforceable SaaS:
**server-side auth, entitlements, Stripe billing, a market-data proxy, and the
signal-history schema** (the long-term data moat). The static frontend
(GitHub Pages) will call this once it's deployed and has a URL.

> Status: **foundation**. The code is real and runnable, but it does nothing
> useful until you provide credentials (a Postgres database, a JWT secret, and —
> for billing — Stripe keys). Nothing secret is committed; everything comes from
> environment variables.

## Stack
Node ≥ 20 · Express · Postgres (`pg`) · Stripe · JWT (`jsonwebtoken`) · `bcryptjs`.

## Run locally
```bash
cd server
cp .env.example .env      # then fill in DATABASE_URL and JWT_SECRET
npm install
npm run migrate           # applies migrations/*.sql
npm start                 # http://localhost:8080/health
```

## Deploy (Railway)
1. Create a Railway project; add a **PostgreSQL** plugin (gives `DATABASE_URL`).
2. New service → deploy this repo, **root directory = `server/`** (`railway.json` sets build/start/health).
3. Add the env vars from `.env.example` in the Railway dashboard (never commit them).
4. First boot runs migrations automatically.

## Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/health` | – | liveness |
| POST | `/auth/signup` | – | `{email,password}` → `{token,user}` |
| POST | `/auth/login` | – | `{email,password}` → `{token,user}` |
| GET  | `/auth/me` | Bearer | current user + entitlements |
| POST | `/billing/checkout` | Bearer | `{plan:"lite"\|"pro"}` → Stripe Checkout URL |
| POST | `/billing/portal` | Bearer | Stripe billing-portal URL |
| POST | `/billing/webhook` | Stripe sig | subscription lifecycle → tier (source of truth) |
| GET  | `/api/candles?symbol=&interval=` | – | OHLCV proxy (no CORS hop) |
| GET  | `/api/fundamentals?symbol=` | – | FMP proxy (key stays server-side) |
| GET  | `/api/congress/recent?days=&type=&limit=` | Bearer | recent Congressional disclosures |
| GET  | `/api/congress/ticker/:symbol?days=` | Bearer | Congressional trades in one ticker |
| GET  | `/api/congress/spikes?days=&minMembers=` | Bearer | tickers several members are trading (investment "spikes") |
| POST | `/api/congress/sync` | Bearer | force a refresh of the Congress cache |

## Congressional trades
`src/congress.js` fetches the public **House & Senate "Stock Watcher"** bulk
datasets **server-side** (one fetch serves everyone — no browser CORS and no
per-user free-API quota), normalizes them (amount ranges, dates, buy/sell/
exchange), de-dupes, and caches them in `congress_trades`. Reads auto-refresh
when the cache is older than `CONGRESS_SYNC_TTL_HOURS` (blocking only on the
very first, empty load). Source URLs are env-configurable so a dataset move
doesn't require a code change; if a source is unreachable, that source is
skipped and cached data is served — never fabricated rows.

## Enforcement model
`src/entitlements.js` is the **server-side source of truth** for tier limits.
Client-side gating (`js/tiers.js`) is presentation only. Billing tier changes
happen **only** through the verified Stripe webhook — client-reported
subscription state is never trusted.

## What still needs a decision (not code)
- **Stripe account + Price IDs** for Lite/Pro (`STRIPE_PRICE_*`) and a webhook endpoint secret.
- **Market-data licensing**: the proxy currently forwards the same public
  endpoints the frontend used. Redistributing vendor data to paying users needs
  the redistribution rights reviewed per source (see repo `COMPLIANCE`/`DATA_PROVIDERS`).
- **Frontend wiring**: point the app at this API's URL for auth/billing/data
  (a later increment, once deployed).
