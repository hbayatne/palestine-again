// sentiment.js — market-sentiment & accumulation tools.
//
// Two honest, keyless features layered on top of the price engine:
//
//  1. Crypto Fear & Greed — the canonical Alternative.me index (0–100),
//     which aggregates volatility, momentum, volume, social and dominance
//     into a single crowd-sentiment reading. Contrarian by nature: extreme
//     fear has historically clustered near bottoms, extreme greed near tops.
//
//  2. Accumulation Radar — a "is smart money buying this dip?" proxy built
//     ENTIRELY from real price/volume behaviour plus the Coinbase Premium.
//     It is NOT literal on-chain institutional wallet data (that needs paid
//     APIs); it is an honest, transparent heuristic. Three inputs:
//       • Coinbase Premium — Coinbase (USD) spot vs Binance (USDT) spot.
//         When US desks bid, Coinbase trades at a premium; a persistent
//         premium is a well-known proxy for US/institutional demand.
//       • Accumulation/Distribution divergence — A/D line rising while
//         price falls = money flowing IN on weakness (buying the dip).
//       • Down-day absorption — heavy-volume red candles that close off
//         their lows = sellers being absorbed by waiting bids.
//
// The point: surface a buying opportunity even when the technical signal
// reads SELL or NEUTRAL, without pretending to see data we can't.

const FNG_API = "https://api.alternative.me/fng/";
const BINANCE_TICKER = "https://api.binance.com/api/v3/ticker/price";
const COINBASE_TICKER = "https://api.exchange.coinbase.com/products";

function sfetch(url, ms = 6000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ===== 1. Fear & Greed =====

export async function fetchFearGreed(limit = 31) {
  const res = await sfetch(`${FNG_API}?limit=${limit}&format=json`);
  if (!res.ok) throw new Error(`Fear & Greed ${res.status}`);
  const json = await res.json();
  const data = json && json.data;
  if (!Array.isArray(data) || !data.length) throw new Error("Fear & Greed: empty");
  // API returns newest first — flip to oldest→newest for a left-to-right sparkline.
  const history = data
    .map((d) => ({ ts: (+d.timestamp || 0) * 1000, value: +d.value }))
    .filter((d) => Number.isFinite(d.value))
    .reverse();
  const latest = data[0];
  const prevDay = data[1];
  return {
    value: +latest.value,
    label: latest.value_classification || fgLabel(+latest.value),
    prevValue: prevDay ? +prevDay.value : null,
    asOf: (+latest.timestamp || 0) * 1000,
    history,
  };
}

export function fgLabel(v) {
  if (v <= 24) return "Extreme Fear";
  if (v <= 44) return "Fear";
  if (v <= 55) return "Neutral";
  if (v <= 74) return "Greed";
  return "Extreme Greed";
}

// Plain-English, contrarian read of a Fear & Greed value.
export function fgRead(v) {
  if (v <= 24)
    return "The crowd is fearful — historically closer to accumulation zones than tops. Fear doesn't mean 'buy now', but bottoms are usually built here.";
  if (v <= 44)
    return "Sentiment is cautious. Weak hands are stepping back — often where patient buyers start scaling in.";
  if (v <= 55)
    return "Balanced sentiment — no strong crowd edge either way. Let the technicals and accumulation flow lead.";
  if (v <= 74)
    return "The crowd is greedy. Momentum is with buyers, but chasing here carries more risk than it did lower.";
  return "Extreme greed — euphoria. Historically closer to local tops than bottoms; consider trimming into strength, not chasing.";
}

// tone class for the gauge
export function fgTone(v) {
  if (v <= 24) return "sell"; // fear (contrarian-bullish, but shown red as 'market is scared')
  if (v <= 44) return "warn";
  if (v <= 55) return "hold";
  if (v <= 74) return "warn";
  return "buy"; // greed (shown as hot)
}

// ===== 2. Coinbase Premium =====

// crypto symbol -> Coinbase product (BTCUSDT -> BTC-USD)
function coinbaseProduct(symbol) {
  const base = symbol.replace(/(USDT|BUSD|USDC|USD)$/i, "");
  return `${base}-USD`;
}

// Returns { premiumPct, binance, coinbase } or null if either leg is unavailable.
export async function fetchCoinbasePremium(symbol) {
  try {
    const product = coinbaseProduct(symbol);
    const [bRes, cRes] = await Promise.all([
      sfetch(`${BINANCE_TICKER}?symbol=${encodeURIComponent(symbol)}`),
      sfetch(`${COINBASE_TICKER}/${product}/ticker`),
    ]);
    if (!bRes.ok || !cRes.ok) return null;
    const b = await bRes.json();
    const c = await cRes.json();
    const binance = +b.price;
    const coinbase = +c.price;
    if (!(binance > 0) || !(coinbase > 0)) return null;
    return { premiumPct: ((coinbase - binance) / binance) * 100, binance, coinbase };
  } catch {
    return null;
  }
}

// ===== 3. Accumulation math (pure, from OHLCV candles) =====

// Money-flow multiplier & volume for one candle (Chaikin).
function moneyFlowVolume(c) {
  const range = c.high - c.low;
  const mfm = range > 0 ? ((c.close - c.low) - (c.high - c.close)) / range : 0;
  return mfm * (c.volume || 0);
}

// Accumulation/Distribution line (cumulative money-flow volume).
function adLine(candles) {
  const out = [];
  let acc = 0;
  for (const c of candles) {
    acc += moneyFlowVolume(c);
    out.push(acc);
  }
  return out;
}

// Chaikin Money Flow over the last `period` candles (−1…+1).
function cmf(candles, period = 21) {
  const n = Math.min(period, candles.length);
  let mfv = 0;
  let vol = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    mfv += moneyFlowVolume(candles[i]);
    vol += candles[i].volume || 0;
  }
  return vol > 0 ? mfv / vol : null;
}

// Build the composite accumulation read. `premiumPct` is optional (crypto only).
export function accumulationScore(candles, premiumPct = null) {
  if (!Array.isArray(candles) || candles.length < 30)
    return { available: false, reason: "Not enough price history." };
  const volSum = candles.reduce((s, c) => s + (c.volume || 0), 0);
  if (!(volSum > 0))
    return { available: false, reason: "No volume data for this source." };

  const closes = candles.map((c) => c.close);
  const last = candles.length - 1;

  // Dip depth vs the recent (≈60-bar) high.
  const win = Math.min(60, candles.length);
  let recentHigh = -Infinity;
  for (let i = candles.length - win; i < candles.length; i++)
    if (candles[i].high > recentHigh) recentHigh = candles[i].high;
  const dipPct = recentHigh > 0 ? ((recentHigh - closes[last]) / recentHigh) * 100 : 0;
  const inDip = dipPct >= 8;

  // Accumulation/Distribution divergence over the last ≈20 bars.
  const ad = adLine(candles);
  const N = Math.min(20, candles.length - 1);
  const priceChg = closes[last] - closes[last - N];
  const adChg = ad[last] - ad[last - N];
  const priceFalling = priceChg < 0;
  const priceRising = priceChg > 0;
  const adRising = adChg > 0;
  const adFalling = adChg < 0;
  const bullishDivergence = priceFalling && adRising;
  const bearishDivergence = priceRising && adFalling;

  const flow = cmf(candles, 21);

  // Down-day absorption: on red candles in the window, are closes near the top
  // of their range on above-average volume? (buyers soaking up supply)
  let redVol = 0;
  let redAbsorbVol = 0;
  const avgVol = volSum / candles.length;
  for (let i = candles.length - win; i < candles.length; i++) {
    const c = candles[i];
    if (c.close < c.open) {
      redVol += c.volume || 0;
      const range = c.high - c.low;
      const closePos = range > 0 ? (c.close - c.low) / range : 0.5;
      if ((c.volume || 0) > avgVol && closePos > 0.5) redAbsorbVol += c.volume || 0;
    }
  }
  const absorption = redVol > 0 && redAbsorbVol / redVol > 0.35;

  // ---- Composite score, starting neutral ----
  let score = 50;
  const reasons = [];

  if (flow != null) {
    score += clamp(flow * 60, -25, 25);
    if (flow > 0.05) reasons.push(`Money-flow positive (CMF ${flow.toFixed(2)}) — net buying pressure.`);
    else if (flow < -0.05) reasons.push(`Money-flow negative (CMF ${flow.toFixed(2)}) — net selling.`);
  }
  if (bullishDivergence) {
    score += 20;
    reasons.push("Accumulation/Distribution is rising while price falls — money flowing in on weakness.");
  } else if (bearishDivergence) {
    score -= 14;
    reasons.push("Price up but Accumulation/Distribution falling — distribution into strength.");
  }
  if (premiumPct != null) {
    if (premiumPct > 0.02) {
      score += 15;
      reasons.push(`Coinbase premium +${premiumPct.toFixed(2)}% — US/institutional desks bidding above global price.`);
    } else if (premiumPct < -0.05) {
      score -= 10;
      reasons.push(`Coinbase discount ${premiumPct.toFixed(2)}% — US selling pressure vs global price.`);
    } else {
      reasons.push(`Coinbase premium flat (${premiumPct >= 0 ? "+" : ""}${premiumPct.toFixed(2)}%) — no strong US bid/ask skew.`);
    }
  }
  if (absorption) {
    score += 10;
    reasons.push("Heavy-volume down days closing off their lows — sellers being absorbed.");
  }

  score = clamp(Math.round(score), 0, 100);
  const verdict =
    score >= 70 ? "Strong accumulation" : score >= 58 ? "Accumulating" : score >= 42 ? "Neutral flow" : "Distribution";

  return {
    available: true,
    score,
    verdict,
    dipPct: Math.max(0, dipPct),
    inDip,
    cmf: flow,
    premiumPct,
    bullishDivergence,
    absorption,
    reasons,
  };
}

// The headline value: a buying-opportunity callout when accumulation is strong
// during a dip, EVEN THOUGH the technical signal reads SELL or HOLD/NEUTRAL.
export function accumulationOpportunity(accum, action) {
  if (!accum || !accum.available) return null;
  const signalIsCautious = /SELL/.test(action) || /HOLD|NEUTRAL/.test(action);
  if (accum.score >= 58 && accum.inDip && signalIsCautious) {
    return {
      kind: "buy-dip",
      title: "Possible accumulation opportunity",
      body:
        `The technical signal reads “${action}”, but ${accum.symbol || "this asset"} is down ` +
        `${accum.dipPct.toFixed(1)}% from its recent high while accumulation is ${accum.verdict.toLowerCase()} ` +
        `(radar ${accum.score}/100). Historically, dips bought by stronger hands look like this. ` +
        `It is a context clue, not a green light — size small and keep a stop.`,
    };
  }
  // Inverse warning: signal says BUY but money is leaving (distribution top).
  if (accum.score <= 40 && /BUY/.test(action)) {
    return {
      kind: "distribution",
      title: "Caution — buying into distribution",
      body:
        `The signal reads “${action}”, but money-flow shows distribution (radar ${accum.score}/100). ` +
        `Rallies sold into by stronger hands look like this. Consider waiting for flow to confirm.`,
    };
  }
  return null;
}
