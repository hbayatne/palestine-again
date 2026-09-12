// divergence.js — RSI divergence detection with honest classification.
//
// Divergence = price and momentum (RSI) disagree. Four kinds:
//   • Regular bearish : price higher high,  RSI lower high   → up-move losing steam
//   • Regular bullish : price lower low,    RSI higher low    → down-move losing steam
//   • Hidden bearish  : price lower high,   RSI higher high   → downtrend continuation
//   • Hidden bullish  : price higher low,   RSI lower low     → uptrend continuation
//
// Detection uses proper swing-pivot detection (a bar that is the local extreme
// over `width` bars on each side), not naive adjacent-bar comparisons, and
// applies configurable magnitude/separation thresholds so noise doesn't count.
//
// Crucially it does NOT call every divergence a reversal. Regular divergence
// against a strong trend is flagged as a MOMENTUM WARNING (trends routinely
// absorb one divergence); only in a weakening/rangebound context is it called a
// POTENTIAL REVERSAL. Hidden divergences are labelled trend-continuation.

const DEFAULTS = {
  width: 3,          // bars on each side that define a swing pivot
  lookback: 120,     // how many recent bars to scan
  minRsiDiff: 3,     // minimum RSI differential between the two pivots
  minPriceDiffPct: 0.3, // minimum % price differential
  minSeparation: 5,  // min bars between the two pivots
  maxSeparation: 60, // max bars between the two pivots
  maxBarsAgo: 15,    // the later pivot must be this recent to be "active"
};

function pivotIndices(vals, width, kind) {
  const out = [];
  for (let i = width; i < vals.length - width; i++) {
    const v = vals[i];
    if (v == null) continue;
    let isPivot = true;
    for (let k = 1; k <= width; k++) {
      if (kind === "high") {
        if (!(v >= vals[i - k]) || !(v >= vals[i + k])) { isPivot = false; break; }
      } else {
        if (!(v <= vals[i - k]) || !(v <= vals[i + k])) { isPivot = false; break; }
      }
    }
    if (isPivot) out.push(i);
  }
  return out;
}

function strengthOf(rsiDiff, priceDiffPct, sep, opts) {
  const rsiMag = Math.min(1, Math.abs(rsiDiff) / 15);
  const priceMag = Math.min(1, Math.abs(priceDiffPct) / 5);
  // separation is best mid-band; extremes (too tight / too wide) score lower
  const mid = (opts.minSeparation + opts.maxSeparation) / 2;
  const sepScore = 1 - Math.min(1, Math.abs(sep - mid) / (opts.maxSeparation - opts.minSeparation));
  return Math.round(100 * (0.5 * rsiMag + 0.3 * priceMag + 0.2 * sepScore));
}

// context: { trendUp: bool|null, adx: number|null } — drives reversal vs warning.
function classify(kind, direction, context) {
  const strongTrend = context && context.adx != null && context.adx >= 25;
  if (kind === "hidden") {
    return {
      tag: "Trend continuation",
      tone: direction === "bullish" ? "buy" : "sell",
      meaning: direction === "bullish"
        ? "Momentum held up better than price on the pullback — a continuation signal in an uptrend."
        : "Momentum stayed weaker than price on the bounce — a continuation signal in a downtrend.",
    };
  }
  // regular divergence
  const counterTrend =
    (direction === "bearish" && context && context.trendUp === true) ||
    (direction === "bullish" && context && context.trendUp === false);
  if (strongTrend && counterTrend) {
    return {
      tag: "Momentum warning",
      tone: "warn",
      meaning: "The trend is still strong, so this reads as momentum cooling — not a confirmed reversal. Strong trends often absorb one divergence before turning.",
    };
  }
  return {
    tag: "Potential reversal",
    tone: direction === "bullish" ? "buy" : "sell",
    meaning: direction === "bullish"
      ? "Selling pressure is fading at the lows while the broader trend isn't strongly down — a possible bottoming signal. Confirm with a break of structure."
      : "Buying pressure is fading at the highs while the broader trend isn't strongly up — a possible topping signal. Confirm with a break of structure.",
  };
}

// candles: [{high,low,close,time}], rsi: aligned RSI array, context optional.
export function detectDivergences(candles, rsi, context = {}, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!Array.isArray(candles) || !Array.isArray(rsi) || candles.length < opts.width * 2 + opts.minSeparation + 2)
    return { available: false, reason: "Not enough price history for divergence analysis.", all: [], primary: null };

  const n = candles.length;
  const from = Math.max(opts.width, n - opts.lookback);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const hiPivots = pivotIndices(highs, opts.width, "high").filter((i) => i >= from && rsi[i] != null);
  const loPivots = pivotIndices(lows, opts.width, "low").filter((i) => i >= from && rsi[i] != null);

  const found = [];

  const consider = (a, b, priceArr, useHigh) => {
    const sep = b - a;
    if (sep < opts.minSeparation || sep > opts.maxSeparation) return;
    const p1 = priceArr[a], p2 = priceArr[b];
    const r1 = rsi[a], r2 = rsi[b];
    if (p1 == null || p2 == null || r1 == null || r2 == null) return;
    const priceDiffPct = ((p2 - p1) / p1) * 100;
    const rsiDiff = r2 - r1;
    if (Math.abs(rsiDiff) < opts.minRsiDiff || Math.abs(priceDiffPct) < opts.minPriceDiffPct) return;

    let kind = null, direction = null;
    if (useHigh) {
      // pivot highs → bearish family
      if (p2 > p1 && r2 < r1) { kind = "regular"; direction = "bearish"; }
      else if (p2 < p1 && r2 > r1) { kind = "hidden"; direction = "bearish"; }
    } else {
      // pivot lows → bullish family
      if (p2 < p1 && r2 > r1) { kind = "regular"; direction = "bullish"; }
      else if (p2 > p1 && r2 < r1) { kind = "hidden"; direction = "bullish"; }
    }
    if (!kind) return;

    const cls = classify(kind, direction, context);
    const label = `${kind === "hidden" ? "Hidden" : "Regular"} ${direction}`;
    found.push({
      kind, direction, label,
      idx1: a, idx2: b,
      t1: candles[a].time, t2: candles[b].time,
      price1: p1, price2: p2, rsi1: r1, rsi2: r2,
      priceDiffPct, rsiDiff,
      bars: sep,
      barsAgo: n - 1 - b,
      strength: strengthOf(rsiDiff, priceDiffPct, sep, opts),
      classification: cls.tag,
      tone: cls.tone,
      meaning: cls.meaning,
      pivotKind: useHigh ? "high" : "low",
    });
  };

  // Compare each pivot with the most recent earlier pivots (within maxSeparation).
  for (let j = 1; j < hiPivots.length; j++)
    for (let i = j - 1; i >= 0 && hiPivots[j] - hiPivots[i] <= opts.maxSeparation; i--)
      consider(hiPivots[i], hiPivots[j], highs, true);
  for (let j = 1; j < loPivots.length; j++)
    for (let i = j - 1; i >= 0 && loPivots[j] - loPivots[i] <= opts.maxSeparation; i--)
      consider(loPivots[i], loPivots[j], lows, false);

  // Sort newest+strongest first.
  found.sort((a, b) => b.idx2 - a.idx2 || b.strength - a.strength);

  // "Active" divergences = later pivot is recent.
  const active = found.filter((d) => d.barsAgo <= opts.maxBarsAgo);
  const primary = (active[0] || null);

  return { available: true, all: found, active, primary };
}
