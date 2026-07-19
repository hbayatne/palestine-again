// tiers.js — subscription plan definitions and the feature matrix.
// Higher tiers unlock more indicators, more timeframes, and richer, easier-to-
// read output. Prices are placeholders for when the product is monetized.

export const TIERS = {
  free: {
    id: "free",
    name: "Free",
    price: "$0",
    priceNote: "forever",
    tagline: "Get a feel for the market.",
    // which indicator voters feed the signal
    voters: ["trend", "rsi", "macd"],
    timeframes: ["1d"],
    confidence: false,
    tradePlan: false,
    fundamentals: false,
    plainEnglish: false,
    chart: true,
    perks: [
      "Buy / Sell / Hold signal",
      "3 core indicators",
      "Daily timeframe",
      "Any asset (stocks, crypto, forex)",
    ],
    locked: [
      "Confidence score",
      "Trade plan (entry / stop / target)",
      "Full indicator suite",
      "Fundamentals",
    ],
  },
  lite: {
    id: "lite",
    name: "Lite",
    price: "$9",
    priceNote: "/month",
    tagline: "For the active trader.",
    voters: ["trend", "rsi", "macd", "stoch", "bollinger", "emaCross"],
    timeframes: ["1h", "4h", "1d", "1w"],
    confidence: true,
    tradePlan: true,
    fundamentals: false,
    plainEnglish: false,
    chart: true,
    perks: [
      "Everything in Free, plus:",
      "6 indicators",
      "Confidence score",
      "ATR trade plan (entry / stop / target)",
      "Hourly → weekly timeframes",
    ],
    locked: ["Fundamentals analysis", "Plain-English summary", "15-minute timeframe"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: "$29",
    priceNote: "/month",
    tagline: "The full trading desk.",
    voters: "all",
    timeframes: ["15m", "1h", "4h", "1d", "1w"],
    confidence: true,
    tradePlan: true,
    fundamentals: true,
    plainEnglish: true,
    chart: true,
    perks: [
      "Everything in Lite, plus:",
      "Full 7-indicator suite + ADX trend gate",
      "Fundamentals scoring & blend",
      "Plain-English signal summary",
      "All timeframes incl. 15-minute",
    ],
    locked: [],
  },
};

export const TIER_ORDER = ["free", "lite", "pro"];

export function tierRank(id) {
  return TIER_ORDER.indexOf(id);
}

// Given a tier and the full list of voter keys, return the allowed subset.
export function allowedVoters(tier, allKeys) {
  if (!tier || tier.voters === "all") return allKeys.slice();
  return allKeys.filter((k) => tier.voters.includes(k));
}
