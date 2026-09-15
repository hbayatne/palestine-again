// entitlements.js — the server-side source of truth for what each tier may do.
// The frontend's tiers.js is for presentation; enforcement lives HERE, because
// client-side gating can be bypassed. Every gated route checks these.
export const ENTITLEMENTS = {
  free: {
    tier: "free",
    "alerts.max": 3,
    "watchlists.max": 1,
    "watchlist.symbols.max": 10,
    "portfolio.max": 1,
    "scanner.custom": false,
    "scanner.realtime": false,
    "backtest.enabled": false,
    "ai.monthlyCredits": 10,
    "macro.advanced": false,
    "journal.analytics": false,
    "export.csv": false,
    "api.access": false,
    "data.delayMinutes": 15,
  },
  lite: {
    tier: "lite",
    "alerts.max": 30,
    "watchlists.max": 10,
    "watchlist.symbols.max": 100,
    "portfolio.max": 3,
    "scanner.custom": true,
    "scanner.realtime": false,
    "backtest.enabled": false,
    "ai.monthlyCredits": 200,
    "macro.advanced": false,
    "journal.analytics": true,
    "export.csv": true,
    "api.access": false,
    "data.delayMinutes": 15,
  },
  pro: {
    tier: "pro",
    "alerts.max": 500,
    "watchlists.max": 100,
    "watchlist.symbols.max": 1000,
    "portfolio.max": 25,
    "scanner.custom": true,
    "scanner.realtime": true,
    "backtest.enabled": true,
    "ai.monthlyCredits": 3000,
    "macro.advanced": true,
    "journal.analytics": true,
    "export.csv": true,
    "api.access": true,
    "data.delayMinutes": 0,
  },
};

export function entitlementsFor(tier) {
  return ENTITLEMENTS[tier] || ENTITLEMENTS.free;
}

// Express middleware: require a boolean entitlement to be true for req.user's tier.
export function requireEntitlement(key) {
  return (req, res, next) => {
    const ent = entitlementsFor(req.user?.tier);
    if (ent[key] === true) return next();
    return res.status(403).json({
      error: "upgrade_required",
      message: `Your plan (${ent.tier}) does not include "${key}".`,
      entitlement: key,
    });
  };
}

// Helper for numeric limits (e.g. alerts.max) — returns the cap for the tier.
export function limitFor(tier, key) {
  const ent = entitlementsFor(tier);
  return typeof ent[key] === "number" ? ent[key] : 0;
}
