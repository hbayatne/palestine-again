// valuation.js — fundamental "quality & value" scoring for stocks.
// Turns a normalized fundamentals object into five 1–100 scores, an overall
// score, a letter rating, and a peer-relative standing. Pure functions — no I/O.
//
// The five lenses (from the product spec):
//   1. Profitability  — does it actually make money? (net profit margin)
//   2. Competition    — where it ranks vs industry peers
//   3. "Real" money   — quality of profit (gross margin)
//   4. Survival       — can it weather a bad bear market? (balance sheet + beta)
//   5. Valuation      — are you overpaying? (P/E vs a reasonable P/E → fair price)

function vclamp(v, lo = 1, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

// Piecewise-linear map: points = [[x0,y0],[x1,y1],...] sorted by x.
function interp(x, points) {
  if (x <= points[0][0]) return points[0][1];
  if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

// 1. Profitability — net profit margin as a percentage (e.g. 25 = 25%).
export function scoreProfitability(netMarginPct) {
  if (netMarginPct == null || Number.isNaN(netMarginPct)) return null;
  return Math.round(
    vclamp(interp(netMarginPct, [[-25, 1], [-5, 12], [0, 28], [5, 55], [10, 70], [20, 88], [35, 100]]))
  );
}

// 3. "Is the money real" — gross margin as a percentage.
export function scoreGrossMargin(grossMarginPct) {
  if (grossMarginPct == null || Number.isNaN(grossMarginPct)) return null;
  return Math.round(
    vclamp(interp(grossMarginPct, [[5, 8], [20, 32], [35, 55], [50, 72], [65, 88], [80, 100]]))
  );
}

// 4. Bear-market survival — balance-sheet resilience. Inputs (any may be null):
//   debtToEquity (ratio, e.g. 1.5), currentRatio, netMarginPct, fcfPositive, beta.
export function scoreSurvival(f) {
  const parts = [];
  const weights = [];
  if (f.debtToEquity != null) {
    parts.push(interp(f.debtToEquity, [[0, 100], [0.5, 88], [1, 68], [2, 42], [3, 22], [5, 6]]));
    weights.push(0.3);
  }
  if (f.currentRatio != null) {
    parts.push(interp(f.currentRatio, [[0.4, 8], [1, 45], [1.5, 75], [2, 90], [3, 100]]));
    weights.push(0.25);
  }
  if (f.netMarginPct != null) {
    parts.push(interp(f.netMarginPct, [[-20, 5], [0, 40], [10, 75], [20, 95]]));
    weights.push(0.2);
  }
  if (f.beta != null) {
    parts.push(interp(f.beta, [[0.4, 100], [0.8, 82], [1, 70], [1.5, 45], [2, 28], [3, 8]]));
    weights.push(0.15);
  }
  if (f.fcfPositive != null) {
    parts.push(f.fcfPositive ? 90 : 30);
    weights.push(0.1);
  }
  if (!parts.length) return null;
  const wsum = weights.reduce((a, b) => a + b, 0);
  const score = parts.reduce((a, p, i) => a + p * weights[i], 0) / wsum;
  return Math.round(vclamp(score));
}

// A "reasonable" P/E: anchored at ~16, nudged up for growth (capped), down for
// no growth. Returns { fairPE, fairPrice }.
export function reasonablePE(f) {
  const g = f.revenueGrowthPct == null ? 6 : f.revenueGrowthPct; // assume mid single digit if unknown
  // ~1.6x growth premium on top of a 12 base, clamped to a sane band
  let fairPE = vclamp(12 + g * 1.2, 8, 40);
  const fairPrice = f.eps != null && f.eps > 0 ? fairPE * f.eps : null;
  return { fairPE: Math.round(fairPE * 10) / 10, fairPrice };
}

// 5. Valuation — are you overpaying? Compares P/E to the reasonable P/E.
export function scoreValuation(f) {
  const { fairPE, fairPrice } = reasonablePE(f);
  if (f.pe == null || f.pe <= 0 || f.eps == null || f.eps <= 0) {
    // no positive earnings to value on
    return { score: 30, fairPE, fairPrice, note: "No positive earnings yet — can't value on P/E; judge on growth/story (higher risk)." };
  }
  const ratio = f.pe / fairPE; // >1 = pricier than fair
  const score = Math.round(
    vclamp(interp(ratio, [[0.5, 100], [0.75, 88], [1, 66], [1.3, 46], [1.6, 30], [2, 14], [3, 4]]))
  );
  const overOrUnder = ratio > 1.15 ? "overvalued" : ratio < 0.85 ? "undervalued" : "roughly fair";
  const note =
    `P/E ${f.pe.toFixed(1)} vs a reasonable ~${fairPE} → ${overOrUnder}.` +
    (fairPrice ? ` Fair value ≈ $${fairPrice.toFixed(2)} (price $${f.price != null ? f.price.toFixed(2) : "?"}).` : "");
  return { score, fairPE, fairPrice, ratio, note };
}

// 2. Competition — rank the target within its peer group. peers: array of
// { symbol, marketCap, netMarginPct, grossMarginPct, revenue }. Returns
// { score, rank, of, note } or null if peers unavailable.
export function scoreCompetition(target, peers) {
  const group = [target, ...(peers || [])].filter((p) => p && (p.marketCap != null || p.revenue != null));
  if (group.length < 2) return null;
  const z = (arr) => {
    const vals = arr.filter((v) => v != null);
    if (!vals.length) return () => 0;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    return (v) => (v == null ? 0 : (v - mean) / sd);
  };
  // Use ONE consistent scale metric across the whole group: revenue if every
  // member has it, otherwise market cap for all (peers often only carry cap).
  const useRevenue = group.every((p) => p.revenue != null);
  const scaleOf = (p) => {
    const v = useRevenue ? p.revenue : p.marketCap;
    return v != null ? Math.log(Math.max(1, v)) : null;
  };
  const zScale = z(group.map(scaleOf));
  const zNet = z(group.map((p) => p.netMarginPct));
  const zGross = z(group.map((p) => p.grossMarginPct));
  const strength = (p) => zScale(scaleOf(p)) * 1.0 + zNet(p.netMarginPct) * 0.8 + zGross(p.grossMarginPct) * 0.5;
  const ranked = group
    .map((p) => ({ symbol: p.symbol, s: strength(p) }))
    .sort((a, b) => b.s - a.s);
  const rank = ranked.findIndex((r) => r.symbol === target.symbol) + 1;
  const of = ranked.length;
  const percentile = (of - rank) / (of - 1); // 1 = best
  const score = Math.round(vclamp(15 + percentile * 85));
  const leader = ranked[0].symbol;
  const note =
    rank === 1
      ? `Ranks #1 of ${of} vs peers (${peers.map((p) => p.symbol).join(", ")}) — the leader by scale & margins.`
      : `Ranks #${rank} of ${of} in its peer group (leader: ${leader}).`;
  return { score, rank, of, note };
}

// MOAT / competitive-durability proxy that scales to a whole universe without
// per-stock peer fetches: pricing power (gross margin) + efficiency (net margin)
// + scale (market cap). Used by the Stock Ranker.
export function moatScore(f) {
  const parts = [];
  const w = [];
  if (f.grossMarginPct != null) {
    parts.push(interp(f.grossMarginPct, [[10, 10], [30, 40], [50, 68], [65, 86], [80, 100]]));
    w.push(0.45);
  }
  if (f.netMarginPct != null) {
    parts.push(interp(f.netMarginPct, [[-10, 10], [0, 30], [10, 60], [20, 82], [35, 100]]));
    w.push(0.35);
  }
  if (f.marketCap != null) {
    parts.push(interp(Math.log10(Math.max(1, f.marketCap)), [[8, 20], [9, 40], [10, 60], [11, 78], [12, 92], [13, 100]]));
    w.push(0.2);
  }
  if (!parts.length) return null;
  const ws = w.reduce((a, b) => a + b, 0);
  return Math.round(vclamp(parts.reduce((a, p, i) => a + p * w[i], 0) / ws));
}

// Stability — low volatility (beta), durable profit, and a consistent EPS trend.
export function stabilityScore(f, epsTrend) {
  const parts = [];
  const w = [];
  if (f.beta != null) {
    parts.push(interp(f.beta, [[0.4, 100], [0.8, 85], [1, 72], [1.5, 48], [2, 30], [3, 10]]));
    w.push(0.4);
  }
  if (f.netMarginPct != null) {
    parts.push(interp(f.netMarginPct, [[-10, 15], [0, 45], [10, 72], [20, 92]]));
    w.push(0.3);
  }
  if (epsTrend && epsTrend.length >= 4) {
    const pos = epsTrend.filter((e) => e > 0).length / epsTrend.length;
    let ups = 0;
    for (let i = 1; i < epsTrend.length; i++) if (epsTrend[i] >= epsTrend[i - 1]) ups++;
    const trend = ups / (epsTrend.length - 1);
    parts.push(vclamp(pos * 60 + trend * 40));
    w.push(0.3);
  }
  if (!parts.length) return null;
  const ws = w.reduce((a, b) => a + b, 0);
  return Math.round(vclamp(parts.reduce((a, p, i) => a + p * w[i], 0) / ws));
}

// One ranked row: five pillar scores (1–100) + an overall quality score+grade.
// techScore is the technical signal score (−100..100), folded in lightly.
export function buildRankerRow(f, techScore) {
  const profit = scoreProfitability(f.netMarginPct);
  const moat = moatScore(f);
  const survival = scoreSurvival(f);
  const val = scoreValuation(f);
  const value = val.score;
  const stability = stabilityScore(f, f.epsTrend);
  const pillars = { profit, moat, survival, value, stability };
  const weights = { profit: 0.22, moat: 0.22, survival: 0.2, value: 0.18, stability: 0.18 };
  let sum = 0;
  let wsum = 0;
  for (const k of Object.keys(pillars)) {
    if (pillars[k] != null) {
      sum += pillars[k] * weights[k];
      wsum += weights[k];
    }
  }
  const quality = wsum ? Math.round(sum / wsum) : null;
  // Overall blends quality (85%) with the technical signal (15%).
  const techPct = techScore == null ? null : (techScore + 100) / 2;
  const overall =
    quality == null ? null : Math.round(techPct == null ? quality : quality * 0.85 + techPct * 0.15);
  return {
    symbol: f.symbol,
    name: f.name,
    sector: f.sector,
    marketCap: f.marketCap,
    epsTrend: f.epsTrend || null,
    pillars,
    quality,
    overall,
    grade: overall != null ? letterRating(overall) : "—",
    fairPrice: val.fairPrice,
    price: f.price,
    valuationNote: val.note,
    techScore,
  };
}

// Letter rating from an overall 1–100.
export function letterRating(score) {
  if (score >= 90) return "A+";
  if (score >= 82) return "A";
  if (score >= 74) return "B+";
  if (score >= 66) return "B";
  if (score >= 58) return "C+";
  if (score >= 50) return "C";
  if (score >= 40) return "D";
  return "F";
}

// Combine everything. `f` is the normalized fundamentals; `competition` is the
// result of scoreCompetition (may be null). Returns the full scorecard.
export function buildScorecard(f, competition) {
  const profitability = scoreProfitability(f.netMarginPct);
  const grossMargin = scoreGrossMargin(f.grossMarginPct);
  const survival = scoreSurvival(f);
  const valuation = scoreValuation(f);
  const comp = competition || null;

  const parts = [
    { key: "profitability", label: "Profitability", score: profitability, hint: f.netMarginPct != null ? `Net margin ${f.netMarginPct.toFixed(1)}%` : "No margin data" },
    { key: "competition", label: "Competitive position", score: comp ? comp.score : null, hint: comp ? comp.note : "No peer data" },
    { key: "grossMargin", label: "Quality of profit", score: grossMargin, hint: f.grossMarginPct != null ? `Gross margin ${f.grossMarginPct.toFixed(1)}%` : "No margin data" },
    { key: "survival", label: "Bear-market survival", score: survival, hint: survivalHint(f) },
    { key: "valuation", label: "Valuation (are you overpaying?)", score: valuation.score, hint: valuation.note },
  ];
  const present = parts.filter((p) => p.score != null);
  const overall = present.length ? Math.round(present.reduce((a, p) => a + p.score, 0) / present.length) : null;
  return {
    parts,
    overall,
    rating: overall != null ? letterRating(overall) : "—",
    valuation,
    makesMoney: f.netMarginPct != null ? f.netMarginPct > 0 : null,
  };
}

function survivalHint(f) {
  const bits = [];
  if (f.debtToEquity != null) bits.push(`D/E ${f.debtToEquity.toFixed(2)}`);
  if (f.currentRatio != null) bits.push(`current ratio ${f.currentRatio.toFixed(2)}`);
  if (f.beta != null) bits.push(`beta ${f.beta.toFixed(2)}`);
  return bits.length ? bits.join(" · ") : "Limited balance-sheet data";
}

// Curated peer groups so competition works out-of-the-box for major names.
export const INDUSTRY_PEERS = {
  NVDA: ["AMD", "INTC", "AVGO", "QCOM"],
  AMD: ["NVDA", "INTC", "AVGO", "QCOM"],
  INTC: ["NVDA", "AMD", "AVGO", "TXN"],
  AVGO: ["NVDA", "AMD", "QCOM", "TXN"],
  AAPL: ["MSFT", "GOOGL", "SAMSUNG", "DELL"],
  MSFT: ["AAPL", "GOOGL", "AMZN", "ORCL"],
  GOOGL: ["META", "MSFT", "AMZN", "AAPL"],
  META: ["GOOGL", "SNAP", "PINS", "MSFT"],
  AMZN: ["MSFT", "GOOGL", "WMT", "BABA"],
  TSLA: ["F", "GM", "TM", "RIVN"],
  F: ["GM", "TSLA", "TM", "STLA"],
  GM: ["F", "TSLA", "TM", "STLA"],
  JPM: ["BAC", "WFC", "C", "GS"],
  BAC: ["JPM", "WFC", "C", "USB"],
  KO: ["PEP", "MNST", "KDP"],
  PEP: ["KO", "MDLZ", "KDP"],
  V: ["MA", "AXP", "PYPL"],
  MA: ["V", "AXP", "PYPL"],
  DIS: ["NFLX", "WBD", "PARA", "CMCSA"],
  NFLX: ["DIS", "WBD", "PARA", "AMZN"],
  XOM: ["CVX", "COP", "SHEL", "BP"],
  CVX: ["XOM", "COP", "SHEL", "BP"],
  WMT: ["TGT", "COST", "AMZN"],
  COST: ["WMT", "TGT", "BJ"],
  JNJ: ["PFE", "MRK", "ABBV", "LLY"],
  PFE: ["JNJ", "MRK", "ABBV", "LLY"],
};
