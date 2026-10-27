// trade-manager.js
// Profit protection for OPEN trades — the "preserve profits" layer. The entry
// strategy decides what to buy and the initial stop; this decides how the stop
// RATCHETS as the trade works, so winners run while gains get locked in. Pure
// functions, called once per new bar, stateful through the position object.
// Nothing here ever loosens a stop — it only moves in the profit-locking
// direction.
//
// Two trailing philosophies (opts.trailMode):
//   "structure" (default) — trail just under the last DEFENDED swing low (for
//        longs), with a small ATR buffer. This is the "analyzed level that still
//        lets the trade run": the stop only advances when a new higher-low is
//        confirmed, so ordinary pullbacks don't shake you out — only an actual
//        break of structure does. Tight where it counts, loose enough to run.
//   "atr"  — trail a fixed 2×ATR behind price (smoother, purely mechanical).
//   "both" — take the TIGHTER of the two (max protection / least give-back).
//
// Everything is measured in R (R = initial risk per share):
//   Breakeven at +1R · trail past +1R · scale half at +2R and run the rest.

import * as ta from "./indicators.js";
import { pivots } from "./patterns.js";

export const MGMT_DEFAULTS = {
  breakevenAtR: 1.0,
  trailAtR: 1.0,
  trailMode: "structure",     // "structure" | "atr" | "both"
  trailAtrMult: 2.0,          // ATR trail distance
  structBufferAtrMult: 0.25,  // stop sits this far below the swing low (the "tight" buffer)
  pivotLeft: 2, pivotRight: 2,// swing sensitivity (smaller = more responsive)
  scaleOutAtR: 2.0,
  scaleOutFrac: 0.5,
  useScaleOut: true,
};

export function riskPerShare(pos) {
  return pos.riskPerShare ?? Math.abs(pos.entry - (pos.initialStop ?? pos.stop));
}

// The analyzed-level stop: just beyond the most recent DEFENDED swing (the last
// higher-low price is still holding above, for a long). Buffered by a fraction
// of ATR so a stop-hunt wick doesn't clip it. Returns null if no swing qualifies
// yet (caller falls back to ATR).
export function swingStop(pos, candles, opts = {}, atr = null) {
  const o = { ...MGMT_DEFAULTS, ...opts };
  const { highs, lows } = pivots(candles, o.pivotLeft, o.pivotRight);
  const price = candles[candles.length - 1].close;
  const buf = (atr ?? 0) * o.structBufferAtrMult;
  if (pos.side === "LONG") {
    for (let i = lows.length - 1; i >= 0; i--)
      if (lows[i].price < price) return lows[i].price - buf; // last defended low
    return null;
  }
  for (let i = highs.length - 1; i >= 0; i--)
    if (highs[i].price > price) return highs[i].price + buf;
  return null;
}

// Ratchet the stop (breakeven + structure/ATR trail). Mutates pos.stop /
// pos.beMoved; returns { stop, actions }.
export function managePosition(pos, candles, opts = {}) {
  const o = { ...MGMT_DEFAULTS, ...opts };
  const c = candles[candles.length - 1];
  const long = pos.side === "LONG";
  const R = riskPerShare(pos);
  const actions = [];
  let stop = pos.stop;

  const favPrice = long ? c.high : c.low;
  const rReached = (long ? favPrice - pos.entry : pos.entry - favPrice) / R;

  // 1) Breakeven ratchet
  if (!pos.beMoved && rReached >= o.breakevenAtR) {
    stop = long ? Math.max(stop, pos.entry) : Math.min(stop, pos.entry);
    pos.beMoved = true;
    actions.push({ type: "MOVE_STOP", to: round(stop), reason: `+${o.breakevenAtR}R → stop to breakeven` });
  }

  // 2) Trail past +trailAtR, in the profit-locking direction only
  if (rReached >= o.trailAtR) {
    const atr = ta.last(ta.atr(candles.map((x) => x.high), candles.map((x) => x.low), candles.map((x) => x.close), 14));
    const atrTrail = atr == null ? null : (long ? c.close - o.trailAtrMult * atr : c.close + o.trailAtrMult * atr);
    const structTrail = swingStop(pos, candles, o, atr);

    let trail = null, label = "";
    if (o.trailMode === "atr") { trail = atrTrail; label = `${o.trailAtrMult}×ATR`; }
    else if (o.trailMode === "structure") { trail = structTrail ?? atrTrail; label = structTrail != null ? "under swing low" : "ATR (no swing yet)"; }
    else { // "both" → tighter of the two
      const cands = [atrTrail, structTrail].filter((v) => v != null);
      if (cands.length) { trail = long ? Math.max(...cands) : Math.min(...cands); label = "tighter of ATR/structure"; }
    }

    if (trail != null) {
      const newStop = long ? Math.max(stop, trail) : Math.min(stop, trail);
      if (newStop !== stop) {
        stop = newStop;
        actions.push({ type: "MOVE_STOP", to: round(stop), reason: `trail ${label}` });
      }
    }
  }

  pos.stop = stop;
  return { stop, actions };
}

// Scale-out at +scaleOutAtR: return the partial fill { shares, price, reason } or
// null. Caller applies it (reduce shares, realize PnL, mark scaledOut, trail rest).
export function checkScaleOut(pos, bar, opts = {}) {
  const o = { ...MGMT_DEFAULTS, ...opts };
  if (!o.useScaleOut || pos.scaledOut) return null;
  const long = pos.side === "LONG";
  const R = riskPerShare(pos);
  const level = long ? pos.entry + o.scaleOutAtR * R : pos.entry - o.scaleOutAtR * R;
  const hit = long ? bar.high >= level : bar.low <= level;
  if (!hit) return null;
  const shares = round(pos.shares * o.scaleOutFrac);
  return { shares, price: round(level), reason: `+${o.scaleOutAtR}R → take ${o.scaleOutFrac * 100}% off, trail the rest` };
}

function round(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
