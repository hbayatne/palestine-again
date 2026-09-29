// mtf.js
// Multi-timeframe gating. Your workflow: read the *move* on 1–3h candles, but
// only trade in the direction of the higher-timeframe (daily / weekly) trend.
// This wrapper enforces exactly that — an entry-timeframe breakout is only
// allowed to fire if the daily trend agrees, and weekly agreement upgrades it
// to high-conviction. A signal that fights the higher timeframe is dropped, no
// matter how clean the intraday pattern looks.

import * as ta from "./indicators.js";
import { structure } from "./patterns.js";
import { evaluate } from "./strategy.js";

// Robust higher-timeframe trend read: combine market structure (HH/HL vs LH/LL)
// with the SMA50/SMA200 regime and price location. Returns "up" | "down" | "range".
export function htfTrend(candles) {
  if (!candles || candles.length < 60) return "range";
  const closes = candles.map((c) => c.close);
  const price = ta.last(closes);
  const s50 = ta.last(ta.sma(closes, 50));
  const s200 = ta.last(ta.sma(closes, 200));
  const struct = structure(candles).trend;

  let score = 0; // +up / -down
  if (s50 != null) score += price > s50 ? 1 : -1;
  if (s200 != null) {
    score += s50 > s200 ? 1 : -1;
    score += price > s200 ? 1 : -1;
  }
  if (struct === "up") score += 1;
  if (struct === "down") score -= 1;

  if (score >= 2) return "up";
  if (score <= -2) return "down";
  return "range";
}

// tf = { entry, daily, weekly } — three candle arrays (weekly optional).
// requireWeekly: if true, weekly must also agree (fewer, stronger trades).
export function evaluateMTF(tf, equity, userOpts = {}) {
  const { entry, daily, weekly } = tf;
  const requireWeekly = userOpts.requireWeekly ?? false;

  const sig = evaluate(entry, equity, userOpts);
  if (sig.action === "NO_TRADE") return sig; // already filtered on entry TF

  const long = sig.action === "BUY";
  const wantTrend = long ? "up" : "down";

  const dTrend = daily ? htfTrend(daily) : "range";
  const wTrend = weekly ? htfTrend(weekly) : null;

  // Daily is the primary gate. A range daily is allowed (breakout from a base),
  // but a daily trending AGAINST the entry is a hard reject.
  if (dTrend !== "range" && dTrend !== wantTrend) {
    return { action: "NO_TRADE",
      reason: `Entry signal is ${long ? "long" : "short"} but the daily trend is ${dTrend} — higher timeframe disagrees, skipped.`,
      mtf: { dTrend, wTrend } };
  }
  if (requireWeekly && wTrend && wTrend !== "range" && wTrend !== wantTrend) {
    return { action: "NO_TRADE",
      reason: `Weekly trend is ${wTrend}, against a ${long ? "long" : "short"} — strict weekly filter, skipped.`,
      mtf: { dTrend, wTrend } };
  }

  // Alignment bonus: both HTFs agreeing = your highest-conviction condition.
  let bump = 0;
  const agree = [];
  if (dTrend === wantTrend) { bump += 8; agree.push("daily"); }
  if (wTrend === wantTrend) { bump += 8; agree.push("weekly"); }
  const confidence = Math.min(100, (sig.confidence ?? 50) + bump);

  return {
    ...sig,
    confidence,
    mtf: { dTrend, wTrend, agreeing: agree },
    plan: sig.plan + (agree.length
      ? `  [HTF aligned: ${agree.join(" + ")} ${wantTrend}]`
      : "  [HTF: daily neutral base]"),
  };
}
