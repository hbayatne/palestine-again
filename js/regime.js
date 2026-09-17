// regime.js — interpretable market-regime engine.
//
// Aggregates a handful of market internals into a single 0–100 "risk appetite"
// read (Risk-Off … Neutral … Risk-On), and — crucially — shows its work: which
// factors support the read and which contradict it. The methodology is plain and
// inspectable, not a black box.
//
// Inputs are daily candle series for broad indices and macro proxies, all
// fetchable keyless via Yahoo. The engine tolerates missing series (it drops
// that factor and renormalizes), so a flaky fetch degrades gracefully.
//
// Symbols used:
//   ^GSPC  S&P 500        — primary trend
//   ^IXIC  Nasdaq         — growth/tech trend
//   ^RUT   Russell 2000   — small-cap participation (breadth)
//   ^VIX   volatility     — fear gauge
//   HYG    high-yield ETF — credit / risk appetite
//   ^TNX   10Y yield      — rates pressure on equities
//   DX-Y.NYB  US Dollar   — dollar headwind/tailwind
//   RSP,SPY equal vs cap  — market breadth (is the rally broad?)

export const REGIME_SYMBOLS = ["^GSPC", "^IXIC", "^RUT", "^VIX", "HYG", "^TNX", "DX-Y.NYB", "RSP", "SPY"];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function closesOf(c) { return Array.isArray(c) ? c.map((x) => x.close).filter((v) => v != null) : []; }
function smaAt(closes, period, back = 0) {
  const end = closes.length - back;
  if (end < period) return null;
  let s = 0;
  for (let i = end - period; i < end; i++) s += closes[i];
  return s / period;
}
function pctChangeN(closes, n) {
  if (closes.length < n + 1) return null;
  const a = closes[closes.length - 1 - n], b = closes[closes.length - 1];
  return a ? ((b - a) / a) * 100 : null;
}

// Trend vote in [-1,+1] from price position vs its 50/200-day averages + slope.
function trendVote(candles) {
  const c = closesOf(candles);
  if (c.length < 60) return null;
  const price = c[c.length - 1];
  const sma50 = smaAt(c, 50), sma200 = smaAt(c, 200);
  const sma50Prev = smaAt(c, 50, 20);
  let v = 0;
  if (sma200 != null) v += price > sma200 ? 0.5 : -0.5;
  if (sma50 != null) v += price > sma50 ? 0.3 : -0.3;
  if (sma50 != null && sma50Prev != null) v += sma50 > sma50Prev ? 0.2 : -0.2;
  return clamp(v, -1, 1);
}

export function computeMarketRegime(data) {
  const factors = [];
  const add = (key, label, weight, vote, note) => {
    if (vote == null || !isFinite(vote)) return;
    factors.push({ key, label, weight, vote: clamp(vote, -1, 1), note });
  };

  // 1. S&P 500 trend
  const spx = trendVote(data["^GSPC"]);
  add("spx", "S&P 500 trend", 0.22, spx,
    spx == null ? "" : spx > 0.3 ? "SPX above rising 50- & 200-day averages" : spx < -0.3 ? "SPX below its key moving averages" : "SPX trend is mixed");

  // 2. Nasdaq trend
  const ndx = trendVote(data["^IXIC"]);
  add("ndx", "Nasdaq trend", 0.15, ndx,
    ndx == null ? "" : ndx > 0.3 ? "Nasdaq in an uptrend — growth leadership intact" : ndx < -0.3 ? "Nasdaq under pressure" : "Nasdaq trend mixed");

  // 3. Small-cap participation (breadth)
  const rutV = trendVote(data["^RUT"]);
  add("smallcap", "Small-cap participation", 0.12, rutV,
    rutV == null ? "" : rutV > 0.2 ? "Russell 2000 participating — broad risk appetite" : rutV < -0.2 ? "Small caps lagging — narrow, defensive tape" : "Small-cap participation neutral");

  // 4. Volatility (VIX): low/falling = risk-on
  const vixC = closesOf(data["^VIX"]);
  if (vixC.length) {
    const vix = vixC[vixC.length - 1];
    const vixChg = pctChangeN(vixC, 10) || 0;
    let v = vix < 15 ? 0.7 : vix < 19 ? 0.35 : vix < 26 ? -0.3 : -0.8;
    v += vixChg > 12 ? -0.3 : vixChg < -12 ? 0.3 : 0;
    add("vix", "Volatility (VIX)", 0.18, clamp(v, -1, 1),
      `VIX ${vix.toFixed(1)} and ${vixChg >= 0 ? "rising" : "falling"} — ${vix < 19 ? "calm" : vix < 26 ? "elevated" : "stressed"}`);
  }

  // 5. Credit / risk appetite (HYG)
  const hygV = trendVote(data["HYG"]);
  add("credit", "Credit (high-yield)", 0.15, hygV,
    hygV == null ? "" : hygV > 0.2 ? "High-yield credit firm — risk appetite healthy" : hygV < -0.2 ? "Credit weakening — a risk-off tell" : "Credit neutral");

  // 6. Breadth: equal-weight vs cap-weight (RSP/SPY)
  const rsp = closesOf(data["RSP"]), spy = closesOf(data["SPY"]);
  if (rsp.length > 25 && spy.length > 25) {
    const n = Math.min(rsp.length, spy.length);
    const ratio = [];
    for (let i = 0; i < n; i++) ratio.push(rsp[rsp.length - n + i] / spy[spy.length - n + i]);
    const rChg = pctChangeN(ratio, 20) || 0;
    add("breadth", "Market breadth (equal vs cap weight)", 0.1, clamp(rChg / 3, -1, 1),
      rChg > 0.3 ? "Equal-weight leading — rally is broad" : rChg < -0.3 ? "Cap-weight leading — rally is narrow" : "Breadth roughly balanced");
  }

  // 7. Rates: sharply rising 10Y yield = equity headwind
  const tnx = closesOf(data["^TNX"]);
  if (tnx.length) {
    const tChg = pctChangeN(tnx, 20) || 0;
    add("rates", "Rates (10Y yield)", 0.1, clamp(-tChg / 8, -1, 1),
      `10Y yield ${tChg >= 0 ? "+" : ""}${tChg.toFixed(1)}% over ~1 month — ${tChg > 5 ? "rising, a headwind" : tChg < -5 ? "falling, a tailwind" : "steady"}`);
  }

  // 8. US Dollar: sharply rising = risk-off headwind
  const dxy = closesOf(data["DX-Y.NYB"]);
  if (dxy.length) {
    const dChg = pctChangeN(dxy, 20) || 0;
    add("dollar", "US Dollar", 0.08, clamp(-dChg / 4, -1, 1),
      `Dollar ${dChg >= 0 ? "+" : ""}${dChg.toFixed(1)}% over ~1 month — ${dChg > 2 ? "strengthening, a headwind" : dChg < -2 ? "weakening, a tailwind" : "steady"}`);
  }

  if (!factors.length) return { available: false, reason: "Could not load market data for the regime read." };

  const wsum = factors.reduce((s, f) => s + f.weight, 0);
  const weighted = factors.reduce((s, f) => s + f.vote * f.weight, 0) / wsum;
  const score = clamp(Math.round(50 + weighted * 50), 0, 100);

  // agreement → confidence (do the factors point the same way?)
  const mean = factors.reduce((s, f) => s + f.vote, 0) / factors.length;
  const variance = factors.reduce((s, f) => s + (f.vote - mean) ** 2, 0) / factors.length;
  const confidence = Math.round(clamp((1 - Math.sqrt(variance)) * 100, 5, 99));

  const label =
    score >= 70 ? "Risk-On" : score >= 58 ? "Moderate Risk-On" : score >= 42 ? "Neutral" : score >= 30 ? "Moderate Risk-Off" : "Risk-Off";
  const tone = score >= 58 ? "buy" : score >= 42 ? "hold" : "sell";

  const byImpact = [...factors].sort((a, b) => Math.abs(b.vote * b.weight) - Math.abs(a.vote * a.weight));
  const supporting = byImpact.filter((f) => f.vote > 0.15 && f.note).slice(0, 5);
  const contradicting = byImpact.filter((f) => f.vote < -0.15 && f.note).slice(0, 5);

  return {
    available: true,
    score, label, tone, confidence,
    factors, supporting, contradicting,
    asOf: Date.now(),
  };
}
