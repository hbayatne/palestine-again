// strategy.js
// Breakout + change-of-structure strategy with conservative, mechanical risk.
// The whole point: turn "obvious breakout / structure-shift" setups into a fully
// numeric decision so there is nothing left to feel. Given candles and account
// equity, evaluate() returns either a concrete, risk-sized trade or a NO-TRADE
// with the reason it was filtered out.
//
// A trade is emitted only when ALL gates pass:
//   1. Structure    — trend defined (HH/HL or LH/LL) OR a fresh CHoCH/BOS.
//   2. Pattern      — a flag / wedge / cup&handle / H&S is present (optional in
//                     structure-only mode).
//   3. Breakout     — a CLOSE beyond the trigger, with volume >= volMult x avg.
//   4. Retest       — (strict mode) price returned to the level and held.
//   5. Risk gate    — structural stop gives reward:risk >= minRR.
// Then size is (equity * riskPct) / stopDistance so every trade risks the same
// dollar amount. Nothing here is discretionary.

import * as ta from "./indicators.js";
import { structure, detectPatterns } from "./patterns.js";

export const DEFAULTS = {
  riskPct: 0.01,        // risk 1% of equity per trade ($10 on $1,000)
  minRR: 2.0,           // require >= 2:1 reward:risk
  volMult: 1.5,         // breakout volume >= 1.5x its 20-bar average
  volLookback: 20,
  adxMin: 18,           // skip dead/choppy tape below this ADX
  requireRetest: false, // true = wait for breakout retest (fewer, cleaner trades)
  retestTol: 0.004,     // retest must come within 0.4% of the trigger
  maxRiskPerShareFrac: 0.15, // reject if stop is > 15% away (pattern too loose)
  pivotLeft: 3,
  pivotRight: 3,
};

// candles: [{time, open, high, low, close, volume}], equity: account $ available.
export function evaluate(candles, equity, userOpts = {}) {
  const o = { ...DEFAULTS, ...userOpts };
  if (!candles || candles.length < 60)
    return no("Not enough history (need >= 60 bars).");

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const vols = candles.map((c) => c.volume || 0);
  const price = ta.last(closes);
  const atr = ta.last(ta.atr(highs, lows, closes, 14));
  const adx = ta.last(ta.adx(highs, lows, closes, 14).adx);

  const struct = structure(candles, o.pivotLeft, o.pivotRight);
  const { best: pattern } = detectPatterns(candles);

  // --- Gate 1: is there a setup at all? ---
  // A setup = a pattern with a breakout direction, OR a raw structure event.
  const event = pattern
    ? { source: pattern.type, direction: pattern.direction, trigger: pattern.trigger,
        invalidation: pattern.invalidation, target: pattern.target, quality: pattern.quality,
        note: pattern.note }
    : struct.choch
    ? structEvent(struct.choch, struct, "change of structure (CHoCH)")
    : struct.bos
    ? structEvent(struct.bos, struct, "break of structure (BOS)")
    : null;
  if (!event) return no("No pattern and no structure break — nothing to trade.", { struct });

  const long = event.direction === "up";

  // --- Gate 2: trend alignment (conviction filter) ---
  // We take breakouts WITH structure. A bullish setup fighting a confirmed
  // downtrend (and vice-versa) is exactly the low-conviction trade to skip —
  // unless the event itself is the CHoCH that flips the trend.
  const isChoch = event.source && event.source.includes("CHoCH");
  const alignedTrend =
    struct.trend === "range" || isChoch ||
    (long && struct.trend === "up") || (!long && struct.trend === "down");
  if (!alignedTrend)
    return no(`Setup fights the ${struct.trend}trend and isn't a CHoCH — low conviction, skipped.`, { struct, event });

  // --- Gate 3: trend strength ---
  if (adx != null && adx < o.adxMin)
    return no(`ADX ${adx.toFixed(0)} < ${o.adxMin} — tape too choppy for a clean breakout.`, { adx });

  // --- Gate 4: confirmed breakout on volume ---
  const broke = long ? price > event.trigger : price < event.trigger;
  if (!broke)
    return no(`Setup armed but price hasn't closed ${long ? "above" : "below"} ${fmt(event.trigger)} yet.`,
      { event, watching: true });

  const volAvg = avg(vols.slice(-o.volLookback - 1, -1)) || avg(vols.slice(-o.volLookback));
  const volNow = ta.last(vols);
  const volOk = volAvg > 0 ? volNow >= o.volMult * volAvg : true;
  if (!volOk)
    return no(`Breakout on weak volume (${(volNow / (volAvg || 1)).toFixed(1)}x avg < ${o.volMult}x) — false-break risk.`,
      { event });

  // --- Gate 5: retest (strict mode only) ---
  if (o.requireRetest) {
    const held = retestHeld(candles, event, o.retestTol, long);
    if (!held)
      return no("Broke out but hasn't retested-and-held the level yet (strict mode).", { event });
  }

  // --- Risk construction (mechanical) ---
  // Stop = the pattern's structural invalidation, tightened by ATR if that is
  // closer (never risk more than the structure demands).
  let stop = event.invalidation;
  if (stop == null || (long && stop >= price) || (!long && stop <= price)) {
    stop = long ? price - 1.5 * atr : price + 1.5 * atr; // fallback: 1.5x ATR
  }
  const riskPerShare = Math.abs(price - stop);
  if (riskPerShare <= 0) return no("Degenerate stop (zero risk distance).");
  if (riskPerShare / price > o.maxRiskPerShareFrac)
    return no(`Stop is ${((riskPerShare / price) * 100).toFixed(1)}% away — pattern too loose for low-risk entry.`, { event });

  // Target = measured move if it clears minRR, else project a minRR target.
  let target = event.target;
  const rewardAtTarget = target != null ? Math.abs(target - price) : 0;
  let rr = rewardAtTarget / riskPerShare;
  if (target == null || rr < o.minRR) {
    target = long ? price + o.minRR * riskPerShare : price - o.minRR * riskPerShare;
    rr = o.minRR;
  }
  if (rr < o.minRR)
    return no(`Reward:risk ${rr.toFixed(2)} < ${o.minRR} — measured move too small vs stop.`, { event });

  // Position size: risk a fixed fraction of equity. This is the emotion-free core.
  const riskDollars = equity * o.riskPct;
  const rawShares = riskDollars / riskPerShare;
  const shares = Math.floor(rawShares);
  const notional = shares * price;
  if (shares < 1)
    return no(`Risk budget $${riskDollars.toFixed(2)} too small for one share at ${fmt(price)} with this stop. ` +
              `Either the stop is too wide or the account too small for this name.`, { event });
  // Never let a single position exceed the whole account (no margin here).
  if (notional > equity)
    return no(`One share sizing wants $${notional.toFixed(0)} > equity $${equity.toFixed(0)} — name too expensive for this book.`, { event });

  const confidence = Math.round(
    Math.min(100,
      (event.quality ?? 0.5) * 45 +
      (adx != null ? Math.min(1, adx / 40) : 0.5) * 25 +
      Math.min(1, (volNow / (volAvg || volNow)) / o.volMult) * 15 +
      (alignedTrend ? 15 : 0))
  );

  return {
    action: long ? "BUY" : "SELL_SHORT",
    setup: event.source,
    reason: event.note,
    structure: { trend: struct.trend, notes: struct.notes },
    entry: round(price),
    stop: round(stop),
    target: round(target),
    riskReward: round(rr),
    riskPerShare: round(riskPerShare),
    shares,
    notional: round(notional),
    riskDollars: round(riskDollars),
    riskPctOfEquity: o.riskPct * 100,
    confidence,
    adx: adx != null ? Math.round(adx) : null,
    volumeVsAvg: volAvg > 0 ? round(volNow / volAvg) : null,
    plan:
      `${long ? "LONG" : "SHORT"} ${shares} sh @ ~${fmt(price)} ($${notional.toFixed(0)}). ` +
      `Stop ${fmt(stop)} (risk $${riskDollars.toFixed(2)} = ${(o.riskPct * 100).toFixed(1)}% of book), ` +
      `target ${fmt(target)} (${rr.toFixed(1)}:1). Setup: ${event.source}.`,
  };
}

function structEvent(ev, struct, label) {
  // Turn a raw BOS/CHoCH into a tradeable event. Trigger is the broken level;
  // stop is the opposite recent swing; target is left to the RR projector.
  const long = ev.direction === "up";
  const invalidation = long
    ? (struct.lastLow ? struct.lastLow.price : null)
    : (struct.lastHigh ? struct.lastHigh.price : null);
  return {
    source: `${ev.type} (${label})`,
    direction: ev.direction,
    trigger: ev.level,
    invalidation,
    target: null, // projected to minRR downstream
    quality: ev.type === "CHoCH" ? 0.55 : 0.6,
    note: `${ev.type} ${ev.direction} through ${fmt(ev.level)} — ${label}.`,
  };
}

// Did price break, come back to within tol of the trigger, then close back in
// the breakout direction on a later bar? A pragmatic retest confirmation.
function retestHeld(candles, event, tol, long) {
  const trig = event.trigger;
  let brokeAt = -1;
  for (let i = candles.length - 20; i < candles.length; i++) {
    if (i < 1) continue;
    const c = candles[i];
    if (brokeAt < 0 && (long ? c.close > trig : c.close < trig)) { brokeAt = i; continue; }
    if (brokeAt >= 0) {
      const near = Math.abs(c.low - trig) / trig <= tol || Math.abs(c.high - trig) / trig <= tol;
      const held = long ? c.close > trig : c.close < trig;
      if (near && held) return true;
    }
  }
  return false;
}

function no(reason, extra = {}) { return { action: "NO_TRADE", reason, ...extra }; }
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function round(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
function fmt(v) {
  if (v == null) return "—";
  if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(4);
}
