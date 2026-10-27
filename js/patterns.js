// patterns.js
// Chart-structure and classical-pattern detection for the breakout / change-of-
// structure strategy. Pure functions over OHLCV candles, no dependencies, same
// house style as indicators.js: aligned reasoning, explicit levels, no black box.
//
// IMPORTANT / honesty note: classical patterns are inherently fuzzy. These
// detectors approximate them with numeric tolerances so they can be *tested*,
// not so they can be trusted on faith. Every detection returns the concrete
// levels (trigger, invalidation/stop, measured target) and a 0..1 quality score
// so downstream code — and a backtest — can judge whether the edge is real.
//
// Candle shape everywhere: { time, open, high, low, close, volume }.

// ---------------------------------------------------------------------------
// Swing pivots — the atoms of market structure.
// A pivot high at index i means high[i] is the strict max over [i-L, i+L].
// A pivot low is the symmetric min. `left`/`right` are the confirmation windows;
// a larger `right` means later confirmation but less noise.
// ---------------------------------------------------------------------------
export function pivots(candles, left = 3, right = 3) {
  const highs = [];
  const lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high, kind: "H" });
    if (isLow) lows.push({ index: i, price: candles[i].low, kind: "L" });
  }
  // merged, time-ordered swing sequence
  const swings = [...highs, ...lows].sort((a, b) => a.index - b.index);
  return { highs, lows, swings };
}

// ---------------------------------------------------------------------------
// Market structure state + BOS / CHoCH.
// Walks the alternating swing sequence and classifies the trend from the last
// pair of same-kind pivots (higher-highs & higher-lows = up, etc.), and flags:
//   BOS  (break of structure)  — trend continuation: price takes out the last
//        swing high in an uptrend (or swing low in a downtrend).
//   CHoCH (change of character) — the first counter-trend break: in an uptrend,
//        price closes below the most recent higher-low; the earliest objective
//        sign the structure is flipping. This is the "change of structure" trade.
// ---------------------------------------------------------------------------
export function structure(candles, left = 3, right = 3) {
  const { highs, lows } = pivots(candles, left, right);
  const lastClose = candles[candles.length - 1].close;

  const hh = highs.slice(-2);
  const ll = lows.slice(-2);

  let trend = "range";
  const notes = [];
  if (hh.length === 2 && ll.length === 2) {
    const higherHighs = hh[1].price > hh[0].price;
    const higherLows = ll[1].price > ll[0].price;
    const lowerHighs = hh[1].price < hh[0].price;
    const lowerLows = ll[1].price < ll[0].price;
    if (higherHighs && higherLows) { trend = "up"; notes.push("higher highs + higher lows"); }
    else if (lowerHighs && lowerLows) { trend = "down"; notes.push("lower highs + lower lows"); }
    else notes.push("mixed swings — rangebound");
  } else {
    notes.push("not enough confirmed pivots for structure");
  }

  const lastHigh = highs[highs.length - 1] || null;
  const lastLow = lows[lows.length - 1] || null;

  // BOS: continuation break of the most recent pivot in the trend direction.
  let bos = null;
  if (trend === "up" && lastHigh && lastClose > lastHigh.price)
    bos = { type: "BOS", direction: "up", level: lastHigh.price };
  if (trend === "down" && lastLow && lastClose < lastLow.price)
    bos = { type: "BOS", direction: "down", level: lastLow.price };

  // CHoCH: first counter-trend break of the last protected swing.
  let choch = null;
  if (trend === "up" && lastLow && lastClose < lastLow.price)
    choch = { type: "CHoCH", direction: "down", level: lastLow.price };
  if (trend === "down" && lastHigh && lastClose > lastHigh.price)
    choch = { type: "CHoCH", direction: "up", level: lastHigh.price };

  return { trend, notes: notes.join("; "), lastHigh, lastLow, bos, choch, highs, lows };
}

// Least-squares line fit over (index, price) points → { slope, intercept, r2 }.
// Used to characterise trendlines for wedges/flags and to measure convergence.
function fitLine(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    sx += p.index; sy += p.price;
    sxx += p.index * p.index; sxy += p.index * p.price; syy += p.price * p.price;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const ssTot = syy - (sy * sy) / n;
  const ssRes = points.reduce((acc, p) => {
    const pred = slope * p.index + intercept;
    return acc + (p.price - pred) ** 2;
  }, 0);
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

function pct(a, b) { return (a - b) / b; }
function lastN(arr, n) { return arr.slice(Math.max(0, arr.length - n)); }
function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

// ---------------------------------------------------------------------------
// Bull / bear flag.
// A sharp impulse "pole" followed by a shallow counter-drift consolidation that
// retraces < ~50% of the pole on fading volume, then breaks out in the pole's
// direction. Target = pole height projected from the breakout level.
// ---------------------------------------------------------------------------
export function flag(candles, opts = {}) {
  const poleMin = opts.poleMin ?? 0.06;      // pole ≥ 6% move
  const poleBars = opts.poleBars ?? 8;       // over ≤ 8 bars
  const flagBars = opts.flagBars ?? 12;      // consolidation length window
  const maxRetrace = opts.maxRetrace ?? 0.5; // flag retraces < 50% of pole
  const n = candles.length;
  if (n < poleBars + 5) return null;

  const flagSeg = lastN(candles, flagBars);
  const poleEndIdx = n - flagSeg.length;
  const poleSeg = candles.slice(Math.max(0, poleEndIdx - poleBars), poleEndIdx);
  if (poleSeg.length < 3) return null;

  const poleStart = poleSeg[0].close;
  const poleEnd = poleSeg[poleSeg.length - 1].close;
  const poleMove = pct(poleEnd, poleStart);
  const dir = poleMove > 0 ? "up" : "down";
  if (Math.abs(poleMove) < poleMin) return null;

  const flagHigh = Math.max(...flagSeg.map((c) => c.high));
  const flagLow = Math.min(...flagSeg.map((c) => c.low));
  const poleHeight = Math.abs(poleEnd - poleStart);
  const retrace = dir === "up" ? (poleEnd - flagLow) / poleHeight : (flagHigh - poleEnd) / poleHeight;
  if (retrace > maxRetrace) return null; // pulled back too far — not a flag

  // consolidation should drift against the pole (or sideways), not extend it
  const flagCloses = flagSeg.map((c, i) => ({ index: i, price: c.close }));
  const line = fitLine(flagCloses);
  if (!line) return null;
  const driftOk = dir === "up" ? line.slope <= 0.0001 * flagHigh : line.slope >= -0.0001 * flagHigh;

  // volume should fade through the flag vs the pole
  const poleVol = avg(poleSeg.map((c) => c.volume || 0));
  const flagVol = avg(flagSeg.map((c) => c.volume || 0));
  const volFade = poleVol > 0 ? flagVol < poleVol : true;

  const trigger = dir === "up" ? flagHigh : flagLow;
  const invalidation = dir === "up" ? flagLow : flagHigh;
  const target = dir === "up" ? trigger + poleHeight : trigger - poleHeight;

  let quality = 0.4;
  if (driftOk) quality += 0.25;
  if (volFade) quality += 0.2;
  quality += Math.min(0.15, Math.abs(poleMove)); // stronger pole = better
  quality = Math.min(1, quality);

  return {
    type: dir === "up" ? "bull_flag" : "bear_flag",
    direction: dir, trigger, invalidation, target,
    quality,
    note: `${dir === "up" ? "Bull" : "Bear"} flag: ${(poleMove * 100).toFixed(1)}% pole, ${(retrace * 100).toFixed(0)}% retrace, volume ${volFade ? "fading" : "not fading"}.`,
  };
}

// ---------------------------------------------------------------------------
// Rising (bearish) / falling (bullish) wedge.
// Two converging trendlines fit to recent pivot highs and lows. Rising wedge:
// both slopes up, converging → break DOWN. Falling wedge: both slopes down,
// converging → break UP. Target = wedge height at its widest, projected from
// the break.
// ---------------------------------------------------------------------------
export function wedge(candles, opts = {}) {
  const left = opts.left ?? 2, right = opts.right ?? 2;
  const { highs, lows } = pivots(candles, left, right);
  const H = lastN(highs, 3), L = lastN(lows, 3);
  if (H.length < 2 || L.length < 2) return null;

  const hi = fitLine(H), lo = fitLine(L);
  if (!hi || !lo) return null;

  const converging = Math.abs(hi.slope) + Math.abs(lo.slope) > 0 &&
    // lines get closer over time: gap at last index < gap at first index
    gapAt(hi, lo, H[H.length - 1].index) < gapAt(hi, lo, H[0].index);
  if (!converging) return null;

  const rising = hi.slope > 0 && lo.slope > 0;
  const falling = hi.slope < 0 && lo.slope < 0;
  if (!rising && !falling) return null;

  const dir = rising ? "down" : "up"; // rising wedge breaks down; falling breaks up
  const idx = candles.length - 1;
  const upperNow = hi.slope * idx + hi.intercept;
  const lowerNow = lo.slope * idx + lo.intercept;
  const height = Math.abs(upperNow - lowerNow);
  const trigger = dir === "up" ? upperNow : lowerNow;
  const invalidation = dir === "up" ? lowerNow : upperNow;
  const target = dir === "up" ? trigger + height : trigger - height;

  const quality = Math.min(1, 0.4 + (hi.r2 + lo.r2) / 2 * 0.6);
  return {
    type: rising ? "rising_wedge" : "falling_wedge",
    direction: dir, trigger, invalidation, target, quality,
    note: `${rising ? "Rising (bearish)" : "Falling (bullish)"} wedge, lines converging (fit R² ${(hi.r2).toFixed(2)}/${(lo.r2).toFixed(2)}). Breaks ${dir}.`,
  };
}

function gapAt(hi, lo, index) {
  return Math.abs((hi.slope * index + hi.intercept) - (lo.slope * index + lo.intercept));
}

// ---------------------------------------------------------------------------
// Head & shoulders / inverse H&S.
// Three consecutive same-kind pivots where the middle is the extreme; neckline
// = line through the two intervening opposite pivots; break of the neckline
// triggers. Target = head-to-neckline height projected from the break.
// ---------------------------------------------------------------------------
export function headAndShoulders(candles, opts = {}) {
  const left = opts.left ?? 3, right = opts.right ?? 3;
  const tol = opts.shoulderTol ?? 0.03; // shoulders within 3% of each other
  const { highs, lows } = pivots(candles, left, right);
  const lastClose = candles[candles.length - 1].close;

  // regular H&S (tops) → bearish
  const h = lastN(highs, 3);
  if (h.length === 3) {
    const [ls, head, rs] = h;
    const shouldersEven = Math.abs(pct(rs.price, ls.price)) < tol;
    const headHighest = head.price > ls.price && head.price > rs.price;
    if (shouldersEven && headHighest) {
      // neckline through the two lows between the shoulders
      const between = lows.filter((l) => l.index > ls.index && l.index < rs.index);
      if (between.length >= 1) {
        const neck = avg(between.map((l) => l.price));
        const height = head.price - neck;
        return {
          type: "head_and_shoulders", direction: "down",
          trigger: neck, invalidation: rs.price, target: neck - height,
          quality: Math.min(1, 0.5 + (1 - Math.abs(pct(rs.price, ls.price)) / tol) * 0.3),
          armed: lastClose > neck,
          note: `Head & shoulders top, neckline ~${neck.toFixed(2)}. Bearish on neckline break.`,
        };
      }
    }
  }
  // inverse H&S (bottoms) → bullish
  const l = lastN(lows, 3);
  if (l.length === 3) {
    const [ls, head, rs] = l;
    const shouldersEven = Math.abs(pct(rs.price, ls.price)) < tol;
    const headLowest = head.price < ls.price && head.price < rs.price;
    if (shouldersEven && headLowest) {
      const between = highs.filter((hh) => hh.index > ls.index && hh.index < rs.index);
      if (between.length >= 1) {
        const neck = avg(between.map((hh) => hh.price));
        const height = neck - head.price;
        return {
          type: "inverse_head_and_shoulders", direction: "up",
          trigger: neck, invalidation: rs.price, target: neck + height,
          quality: Math.min(1, 0.5 + (1 - Math.abs(pct(rs.price, ls.price)) / tol) * 0.3),
          armed: lastClose < neck,
          note: `Inverse head & shoulders, neckline ~${neck.toFixed(2)}. Bullish on neckline break.`,
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cup & handle (bullish continuation).
// A rounded base (U): left rim and right rim near-even, a clear trough between,
// depth within a sane range; then a small handle drift near the right rim.
// Trigger = rim; target = cup depth projected from the rim.
// ---------------------------------------------------------------------------
export function cupAndHandle(candles, opts = {}) {
  const window = opts.window ?? 40;
  const rimTol = opts.rimTol ?? 0.05;      // rims within 5%
  const minDepth = opts.minDepth ?? 0.08;  // cup at least 8% deep
  const maxDepth = opts.maxDepth ?? 0.5;   // and not a crash
  const n = candles.length;
  if (n < window + 3) return null;

  const seg = lastN(candles, window);
  const closes = seg.map((c) => c.close);
  const leftRim = closes[0];
  const troughIdx = closes.indexOf(Math.min(...closes));
  const trough = closes[troughIdx];
  // right rim = recent local high after the trough
  const afterTrough = seg.slice(troughIdx);
  const rightRim = Math.max(...afterTrough.map((c) => c.high));
  const depth = (leftRim - trough) / leftRim;

  const rimsEven = Math.abs(pct(rightRim, leftRim)) < rimTol;
  const uShaped = troughIdx > window * 0.25 && troughIdx < window * 0.75; // trough in the middle
  const depthOk = depth > minDepth && depth < maxDepth;
  if (!(rimsEven && uShaped && depthOk)) return null;

  const trigger = rightRim;
  const invalidation = Math.min(...lastN(afterTrough, Math.ceil(window * 0.25)).map((c) => c.low)); // handle low
  const target = trigger + (leftRim - trough);
  return {
    type: "cup_and_handle", direction: "up",
    trigger, invalidation, target,
    quality: Math.min(1, 0.5 + (1 - Math.abs(pct(rightRim, leftRim)) / rimTol) * 0.3),
    note: `Cup & handle, ${(depth * 100).toFixed(0)}% deep, rim ~${rightRim.toFixed(2)}. Bullish on rim break.`,
  };
}

// Run every detector and return the highest-quality pattern present (or null).
export function detectPatterns(candles, opts = {}) {
  const found = [
    flag(candles, opts.flag),
    wedge(candles, opts.wedge),
    headAndShoulders(candles, opts.hs),
    cupAndHandle(candles, opts.cup),
  ].filter(Boolean);
  found.sort((a, b) => b.quality - a.quality);
  return { best: found[0] || null, all: found };
}
