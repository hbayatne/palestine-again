// trade-manager.js
// Profit protection for OPEN trades — the "preserve profits" layer. The entry
// strategy decides what to buy and where the initial stop goes; this decides how
// the stop RATCHETS as the trade works, so winners are let run while gains get
// locked in. Pure functions, called once per new bar, stateful through the
// position object. Nothing here ever loosens a stop — it only moves in the
// profit-locking direction.
//
// The three mechanics, all measured in R (R = initial risk per share):
//   1. Breakeven  — at +1R, stop jumps to entry. The trade can no longer lose.
//   2. Trail      — past +1R, stop trails 2×ATR behind price (ratchet only).
//   3. Scale-out  — at +2R, take half off, let the rest run on the trail.

import * as ta from "./indicators.js";

export const MGMT_DEFAULTS = {
  breakevenAtR: 1.0,   // +1R → stop to entry
  trailAtR: 1.0,       // start trailing past +1R
  trailAtrMult: 2.0,   // trail distance = 2×ATR(14)
  scaleOutAtR: 2.0,    // +2R → scale out
  scaleOutFrac: 0.5,   // ...half the position
  useScaleOut: true,
};

// R distance per share for a position.
export function riskPerShare(pos) {
  return pos.riskPerShare ?? Math.abs(pos.entry - (pos.initialStop ?? pos.stop));
}

// Ratchet the stop (breakeven + ATR trail) given candles up to the current bar.
// Mutates pos.stop / pos.beMoved and returns { stop, actions }.
export function managePosition(pos, candles, opts = {}) {
  const o = { ...MGMT_DEFAULTS, ...opts };
  const c = candles[candles.length - 1];
  const long = pos.side === "LONG";
  const R = riskPerShare(pos);
  const actions = [];
  let stop = pos.stop;

  const favPrice = long ? c.high : c.low;           // best excursion this bar
  const rReached = (long ? favPrice - pos.entry : pos.entry - favPrice) / R;

  // 1) Breakeven ratchet
  if (!pos.beMoved && rReached >= o.breakevenAtR) {
    stop = long ? Math.max(stop, pos.entry) : Math.min(stop, pos.entry);
    pos.beMoved = true;
    actions.push({ type: "MOVE_STOP", to: round(stop), reason: `+${o.breakevenAtR}R → stop to breakeven` });
  }

  // 2) ATR trail (ratchet only in the profit-locking direction)
  if (rReached >= o.trailAtR) {
    const atr = ta.last(ta.atr(candles.map((x) => x.high), candles.map((x) => x.low), candles.map((x) => x.close), 14));
    if (atr != null) {
      const trail = long ? c.close - o.trailAtrMult * atr : c.close + o.trailAtrMult * atr;
      const newStop = long ? Math.max(stop, trail) : Math.min(stop, trail);
      if (newStop !== stop) {
        stop = newStop;
        actions.push({ type: "MOVE_STOP", to: round(stop), reason: `trail ${o.trailAtrMult}×ATR` });
      }
    }
  }

  pos.stop = stop;
  return { stop, actions };
}

// Scale-out check: if the bar reaches +scaleOutAtR and we haven't scaled yet,
// return the partial fill { shares, price, reason }; else null. Caller applies
// it (reduce shares, realize PnL, mark pos.scaledOut, then trail the remainder).
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
