// edge.js — historical "edge" analytics and market-regime detection.
//
// computeEdge walks the loaded candles, re-runs the SAME signal engine at each
// past bar, and measures what actually happened `horizon` bars later. That turns
// the live signal into an honest, testable statistic: when this asset last
// flashed a signal in this direction, how often did price move the signal's way,
// and by how much? It is an in-sample estimate on one asset's recent history —
// a sanity check on the edge, not a promise about the future.
//
// computeRegime labels the current market state (trend vs. range, volatility)
// from indicators the signal already computed, at no extra cost.

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// analyzeFn(candlesSlice) must return an object with a numeric `.score`
// (i.e. the real analyze() bound to the current tier's voter set).
export function computeEdge(candles, analyzeFn, opts = {}) {
  const horizon = opts.horizon || 10;
  const warmup = Math.min(opts.warmup || 200, Math.floor(candles.length * 0.5));
  const minSamples = opts.minSamples || 12;

  if (!Array.isArray(candles) || candles.length < warmup + horizon + minSamples)
    return { available: false, reason: "Not enough price history to measure an edge at this timeframe." };

  // Current signal direction (what the user is looking at right now).
  let curScore;
  try {
    curScore = analyzeFn(candles).score;
  } catch {
    return { available: false, reason: "Signal could not be evaluated." };
  }
  const curDir = curScore >= 18 ? 1 : curScore <= -18 ? -1 : 0;

  // Backtest: at each historical bar, score the signal and record the forward move.
  const samples = [];
  for (let i = warmup; i < candles.length - horizon; i++) {
    let s;
    try {
      s = analyzeFn(candles.slice(0, i + 1)).score;
    } catch {
      continue;
    }
    const c0 = candles[i].close;
    const cN = candles[i + horizon].close;
    if (!(c0 > 0)) continue;
    const dir = s >= 18 ? 1 : s <= -18 ? -1 : 0;
    samples.push({ dir, fwd: (cN - c0) / c0 });
  }

  if (curDir === 0)
    return {
      available: true,
      directional: false,
      horizon,
      curScore,
      n: samples.filter((x) => x.dir === 0).length,
      note: "The signal is neutral right now, so there's no directional edge to measure. Historically, neutral readings resolve either way — wait for a clearer signal.",
    };

  // Only samples where the historical signal agreed with the current direction.
  const dirSamples = samples.filter((x) => x.dir === curDir);
  if (dirSamples.length < minSamples)
    return { available: false, reason: `Only ${dirSamples.length} past ${curDir > 0 ? "bullish" : "bearish"} signals on this history — too few to estimate an edge.` };

  // "Favorable" = price moved in the signal's direction.
  const signed = dirSamples.map((x) => x.fwd * curDir);
  const wins = signed.filter((v) => v > 0);
  const losses = signed.filter((v) => v <= 0);
  const hitRate = wins.length / signed.length;
  const avgFav = wins.length ? mean(wins) : 0;
  const avgUnfav = losses.length ? mean(losses) : 0; // <= 0
  const expectancy = mean(signed); // avg return per signal, in the signal's favor
  const payoff = avgUnfav !== 0 ? Math.abs(avgFav / avgUnfav) : null;

  // Qualitative edge label from expectancy + hit-rate.
  let label, tone;
  if (expectancy > 0.002 && hitRate >= 0.55) {
    label = "Positive edge";
    tone = "buy";
  } else if (expectancy > 0 && hitRate >= 0.5) {
    label = "Slight edge";
    tone = "warn";
  } else if (expectancy <= -0.002 || hitRate < 0.45) {
    label = "No historical edge";
    tone = "sell";
  } else {
    label = "Neutral / coin-flip";
    tone = "warn";
  }

  return {
    available: true,
    directional: true,
    horizon,
    curScore,
    curDir,
    n: signed.length,
    hitRate,
    avgFav,
    avgUnfav,
    expectancy,
    payoff,
    label,
    tone,
  };
}

// Blend the model's confidence with the historical hit-rate into one number.
export function edgeAdjustedConfidence(modelConfidence, edge) {
  if (!edge || !edge.available || !edge.directional) return modelConfidence;
  const hist = edge.hitRate * 100;
  return Math.round(Math.max(0, Math.min(100, modelConfidence * 0.6 + hist * 0.4)));
}

// Label the market state from indicators the signal already produced.
export function computeRegime(result) {
  const s = result.snapshot || {};
  const adx = result.adx ? result.adx.adx : null;
  const price = result.price;
  const up = s.sma50 != null && s.sma200 != null ? s.sma50 > s.sma200 : s.sma20 != null && s.sma50 != null ? s.sma20 > s.sma50 : null;

  let trend, tone;
  if (adx != null && adx >= 25) {
    trend = up ? "Strong uptrend" : "Strong downtrend";
    tone = up ? "buy" : "sell";
  } else if (adx != null && adx < 18) {
    trend = "Ranging / choppy";
    tone = "warn";
  } else {
    trend = up == null ? "Undefined" : up ? "Weak uptrend" : "Weak downtrend";
    tone = "";
  }

  const atrPct = s.atr != null && price ? (s.atr / price) * 100 : null;
  const vol = atrPct == null ? null : atrPct < 1.5 ? "Low" : atrPct < 4 ? "Normal" : "High";

  return { trend, tone, adx, atrPct, vol, up };
}
