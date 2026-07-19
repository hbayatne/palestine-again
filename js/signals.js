// signals.js
// Turns raw indicators into a transparent, weighted BUY / SELL / HOLD decision.
//
// Design philosophy: no single indicator is trusted. Each one casts a vote in
// [-1, +1] (bearish .. bullish) with an explanation, and votes are combined by
// weight into a composite score in [-100, +100]. The score, the confidence
// (agreement between indicators), and the full breakdown are all returned so
// the user sees *why*, never a black box.

import * as ta from "./indicators.js";

// Weights reflect rough real-world reliability. Trend/momentum confirmation
// (MACD, moving-average structure, ADX-graded) carries more than a single
// oscillator reading. Tune these to your own style.
const WEIGHTS = {
  trend: 0.22, // price vs SMA50/SMA200 structure
  macd: 0.18,
  rsi: 0.14,
  stoch: 0.10,
  bollinger: 0.10,
  emaCross: 0.13,
  obv: 0.08,
  adx: 0.05, // trend-strength gate, mostly a multiplier below
};

function scoreTrend(closes, sma50, sma200) {
  const price = ta.last(closes);
  const s50 = ta.last(sma50);
  const s200 = ta.last(sma200);
  if (s50 == null) return { vote: 0, note: "Not enough data for trend structure." };
  let vote = 0;
  const parts = [];
  if (price > s50) { vote += 0.5; parts.push("price > SMA50"); }
  else { vote -= 0.5; parts.push("price < SMA50"); }
  if (s200 != null) {
    if (s50 > s200) { vote += 0.5; parts.push("SMA50 > SMA200 (golden-cross regime)"); }
    else { vote -= 0.5; parts.push("SMA50 < SMA200 (death-cross regime)"); }
  } else {
    // no long MA available; lean on shorter one a bit more
    vote += price > s50 ? 0.25 : -0.25;
  }
  return { vote: clamp(vote), note: parts.join(", ") };
}

function scoreMacd(m) {
  const line = ta.last(m.macdLine);
  const sig = ta.last(m.signalLine);
  const hist = ta.last(m.histogram);
  const histPrev = ta.prev(m.histogram);
  if (line == null || sig == null) return { vote: 0, note: "MACD undefined." };
  let vote = 0;
  const parts = [];
  if (line > sig) { vote += 0.5; parts.push("MACD above signal (bullish)"); }
  else { vote -= 0.5; parts.push("MACD below signal (bearish)"); }
  if (hist != null && histPrev != null) {
    if (hist > histPrev) { vote += 0.3; parts.push("histogram rising (momentum building)"); }
    else { vote -= 0.3; parts.push("histogram falling (momentum fading)"); }
  }
  if (line > 0) { vote += 0.2; parts.push("MACD > 0"); }
  else { vote -= 0.2; parts.push("MACD < 0"); }
  return { vote: clamp(vote), note: parts.join(", ") };
}

function scoreRsi(rsiArr) {
  const r = ta.last(rsiArr);
  if (r == null) return { vote: 0, note: "RSI undefined." };
  let vote = 0;
  let note;
  if (r <= 30) { vote = 0.8; note = `RSI ${r.toFixed(1)} — oversold, mean-reversion buy zone`; }
  else if (r < 45) { vote = 0.35; note = `RSI ${r.toFixed(1)} — weak, leaning bullish recovery`; }
  else if (r <= 55) { vote = 0; note = `RSI ${r.toFixed(1)} — neutral`; }
  else if (r < 70) { vote = -0.35; note = `RSI ${r.toFixed(1)} — strong, leaning overbought`; }
  else { vote = -0.8; note = `RSI ${r.toFixed(1)} — overbought, distribution risk`; }
  return { vote, note };
}

function scoreStoch(st) {
  const k = ta.last(st.k);
  const d = ta.last(st.d);
  if (k == null || d == null) return { vote: 0, note: "Stochastic undefined." };
  let vote = 0;
  const parts = [];
  if (k < 20) { vote += 0.5; parts.push(`%K ${k.toFixed(0)} oversold`); }
  else if (k > 80) { vote -= 0.5; parts.push(`%K ${k.toFixed(0)} overbought`); }
  else parts.push(`%K ${k.toFixed(0)} mid-range`);
  if (k > d) { vote += 0.3; parts.push("%K crossing up %D"); }
  else { vote -= 0.3; parts.push("%K crossing down %D"); }
  return { vote: clamp(vote), note: parts.join(", ") };
}

function scoreBollinger(bb, closes) {
  const price = ta.last(closes);
  const up = ta.last(bb.upper);
  const lo = ta.last(bb.lower);
  const mid = ta.last(bb.mid);
  if (up == null) return { vote: 0, note: "Bollinger undefined." };
  const pctB = (price - lo) / (up - lo); // 0 = lower band, 1 = upper band
  let vote = 0;
  let note;
  if (pctB <= 0.05) { vote = 0.7; note = "Price riding lower band — stretched, bounce likely"; }
  else if (pctB < 0.35) { vote = 0.3; note = "Price in lower half of bands"; }
  else if (pctB <= 0.65) { vote = 0; note = "Price near band midline"; }
  else if (pctB < 0.95) { vote = -0.3; note = "Price in upper half of bands"; }
  else { vote = -0.7; note = "Price riding upper band — stretched, pullback likely"; }
  return { vote, note, extra: { pctB, mid } };
}

function scoreEmaCross(closes) {
  const e12 = ta.ema(closes, 12);
  const e26 = ta.ema(closes, 26);
  const a = ta.last(e12);
  const b = ta.last(e26);
  const ap = ta.prev(e12);
  const bp = ta.prev(e26);
  if (a == null || b == null) return { vote: 0, note: "EMA cross undefined." };
  let vote = a > b ? 0.5 : -0.5;
  const parts = [a > b ? "EMA12 > EMA26 (bullish)" : "EMA12 < EMA26 (bearish)"];
  if (ap != null && bp != null) {
    const crossedUp = ap <= bp && a > b;
    const crossedDown = ap >= bp && a < b;
    if (crossedUp) { vote = 1; parts.push("fresh bullish crossover"); }
    if (crossedDown) { vote = -1; parts.push("fresh bearish crossover"); }
  }
  return { vote: clamp(vote), note: parts.join(", ") };
}

function scoreObv(obvArr) {
  // slope of OBV over recent window = accumulation vs distribution
  const vals = obvArr.filter((v) => v != null);
  if (vals.length < 10) return { vote: 0, note: "OBV needs more data." };
  const window = vals.slice(-10);
  const slope = window[window.length - 1] - window[0];
  const norm = Math.abs(window[0]) > 0 ? slope / Math.abs(window[0]) : slope;
  let vote = clamp(norm * 5);
  const note =
    slope > 0
      ? "OBV rising — volume confirming accumulation"
      : slope < 0
      ? "OBV falling — volume confirming distribution"
      : "OBV flat";
  return { vote, note };
}

function adxMultiplier(adxArr) {
  // ADX < 20 = choppy/rangebound (dampen trend signals);
  // ADX > 25 = strong trend (amplify). Returns [0.6 .. 1.25] and a note.
  const a = ta.last(adxArr);
  if (a == null) return { mult: 1, adx: null, note: "ADX undefined." };
  let mult;
  let note;
  if (a < 20) { mult = 0.7; note = `ADX ${a.toFixed(0)} — weak/no trend, signals dampened`; }
  else if (a < 25) { mult = 0.9; note = `ADX ${a.toFixed(0)} — trend forming`; }
  else if (a < 40) { mult = 1.15; note = `ADX ${a.toFixed(0)} — strong trend, signals amplified`; }
  else { mult = 1.25; note = `ADX ${a.toFixed(0)} — very strong trend`; }
  return { mult, adx: a, note };
}

function clamp(v, lo = -1, hi = 1) {
  return Math.max(lo, Math.min(hi, v));
}

export const VOTER_KEYS = ["trend", "macd", "rsi", "stoch", "bollinger", "emaCross", "obv"];

// Main entry: candles = [{time, open, high, low, close, volume}, ...]
// opts.voters — optional array of voter keys to include (tier gating). When
// omitted, all voters are used.
export function analyze(candles, opts = {}) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const ind = {
    sma20: ta.sma(closes, 20),
    sma50: ta.sma(closes, 50),
    sma200: ta.sma(closes, 200),
    rsi: ta.rsi(closes, 14),
    macd: ta.macd(closes),
    bollinger: ta.bollinger(closes, 20, 2),
    stochastic: ta.stochastic(highs, lows, closes, 14, 3),
    atr: ta.atr(highs, lows, closes, 14),
    obv: ta.obv(closes, volumes),
    adx: ta.adx(highs, lows, closes, 14),
  };

  const votes = {
    trend: scoreTrend(closes, ind.sma50, ind.sma200),
    macd: scoreMacd(ind.macd),
    rsi: scoreRsi(ind.rsi),
    stoch: scoreStoch(ind.stochastic),
    bollinger: scoreBollinger(ind.bollinger, closes),
    emaCross: scoreEmaCross(closes),
    obv: scoreObv(ind.obv),
  };

  const adxInfo = adxMultiplier(ind.adx.adx);

  // Weighted composite. Trend-following components (trend, macd, emaCross) are
  // scaled by the ADX multiplier; oscillators are not (they work in ranges).
  const trendFollowers = new Set(["trend", "macd", "emaCross"]);
  const allowed = Array.isArray(opts.voters) ? new Set(opts.voters) : null;
  let composite = 0;
  let weightSum = 0;
  const breakdown = [];
  for (const key of Object.keys(votes)) {
    if (allowed && !allowed.has(key)) continue;
    const w = WEIGHTS[key];
    const mult = trendFollowers.has(key) ? adxInfo.mult : 1;
    const contribution = votes[key].vote * w * mult;
    composite += contribution;
    weightSum += w;
    breakdown.push({
      name: key,
      vote: votes[key].vote,
      weight: w,
      contribution,
      note: votes[key].note,
    });
  }
  // normalize to [-100, 100]
  const score = clamp((composite / weightSum) * 100, -100, 100);

  // Confidence = how much the indicators agree (low dispersion => high conf),
  // scaled by signal strength.
  const voteVals = breakdown.map((b) => b.vote);
  const mean = voteVals.reduce((a, b) => a + b, 0) / voteVals.length;
  const variance =
    voteVals.reduce((a, b) => a + (b - mean) ** 2, 0) / voteVals.length;
  const agreement = 1 - Math.min(1, Math.sqrt(variance)); // 0..1
  const confidence = Math.round(
    Math.min(100, (Math.abs(score) / 100) * 0.6 * 100 + agreement * 40)
  );

  // Decision thresholds
  let action;
  if (score >= 45) action = "STRONG BUY";
  else if (score >= 18) action = "BUY";
  else if (score > -18) action = "HOLD / NEUTRAL";
  else if (score > -45) action = "SELL";
  else action = "STRONG SELL";

  // Trade plan from ATR (volatility-based stops keep risk consistent).
  const price = ta.last(closes);
  const atrVal = ta.last(ind.atr);
  const plan = buildTradePlan(action, price, atrVal);

  breakdown.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const plainEnglish = buildPlainEnglish(action, Math.round(score), confidence, breakdown, adxInfo, plan);

  return {
    score: Math.round(score),
    action,
    confidence,
    price,
    breakdown,
    adx: adxInfo,
    plan,
    plainEnglish,
    snapshot: {
      rsi: ta.last(ind.rsi),
      macdHist: ta.last(ind.macd.histogram),
      atr: atrVal,
      sma20: ta.last(ind.sma20),
      sma50: ta.last(ind.sma50),
      sma200: ta.last(ind.sma200),
      stochK: ta.last(ind.stochastic.k),
    },
    indicators: ind,
  };
}

// Translate the numbers into a couple of plain sentences (Pro perk).
function buildPlainEnglish(action, score, confidence, breakdown, adxInfo, plan) {
  const bulls = breakdown.filter((b) => b.vote > 0.15).map((b) => prettyVoter(b.name));
  const bears = breakdown.filter((b) => b.vote < -0.15).map((b) => prettyVoter(b.name));
  const lean = score > 0 ? "bullish" : score < 0 ? "bearish" : "mixed";
  const strength =
    Math.abs(score) >= 45 ? "strongly" : Math.abs(score) >= 18 ? "moderately" : "only slightly";

  let s = `The signals lean ${strength} ${lean} right now (score ${score >= 0 ? "+" : ""}${score}, ${confidence}% agreement). `;
  if (bulls.length) s += `Pushing up: ${bulls.join(", ")}. `;
  if (bears.length) s += `Pushing down: ${bears.join(", ")}. `;
  s += adxInfo.adx != null
    ? adxInfo.adx > 25
      ? "The trend is strong, so trend-following signals carry more weight. "
      : "The market looks choppy/rangebound, so treat breakout signals with caution. "
    : "";
  if (plan && plan.side !== "FLAT") {
    s += `If you act, the plan is to go ${plan.side.toLowerCase()} near ${fmt(plan.entry)}, cut the trade if it hits ${fmt(
      plan.stop
    )}, and aim for ${fmt(plan.target)} — risking about ${plan.riskPct.toFixed(1)}% to make roughly double that. `;
  } else {
    s += "There's no clear edge, so the disciplined move is to wait for a cleaner setup. ";
  }
  s += "Always size positions so a single loss is survivable.";
  return s;
}

function prettyVoter(k) {
  return {
    trend: "moving-average trend",
    macd: "MACD momentum",
    rsi: "RSI",
    stoch: "Stochastic",
    bollinger: "Bollinger Bands",
    emaCross: "EMA crossover",
    obv: "volume flow",
  }[k] || k;
}

function buildTradePlan(action, price, atrVal) {
  if (price == null || atrVal == null) return null;
  const bullish = action.includes("BUY");
  const bearish = action.includes("SELL");
  if (!bullish && !bearish) {
    return {
      side: "FLAT",
      note: "No edge right now — wait for a cleaner setup. Sitting out is a position.",
    };
  }
  const side = bullish ? "LONG" : "SHORT";
  const stopDist = 1.5 * atrVal; // 1.5x ATR stop
  const rr = 2; // target 2:1 reward-to-risk
  const entry = price;
  const stop = bullish ? price - stopDist : price + stopDist;
  const target = bullish ? price + stopDist * rr : price - stopDist * rr;
  return {
    side,
    entry,
    stop,
    target,
    riskReward: rr,
    riskPct: (stopDist / price) * 100,
    note: `${side} plan: enter ~${fmt(entry)}, stop ${fmt(stop)} (1.5×ATR), target ${fmt(
      target
    )} (${rr}:1 R:R). Size so this stop risks ≤1–2% of your account.`,
  };
}

function fmt(v) {
  if (v == null) return "—";
  if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(4);
}

// Blend a fundamentals score (-100..100) with the technical score.
export function combine(technicalScore, fundamentalScore, techWeight = 0.7) {
  if (fundamentalScore == null) return technicalScore;
  return Math.round(technicalScore * techWeight + fundamentalScore * (1 - techWeight));
}
