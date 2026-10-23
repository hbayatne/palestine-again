// Tests for the breakout / change-of-structure strategy, including the new
// 15%-per-name position cap baked into sizing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../js/strategy.js";
import { structure } from "../js/patterns.js";

// Deterministic rising-sawtooth uptrend that forms ascending pivots, then a
// volume-backed breakout bar above the last swing high.
function uptrendBreakout(n = 80) {
  const c = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + i * 0.6 + 3 * Math.sin((i * 2 * Math.PI) / 8);
    c.push({ time: i, open: close - 0.3, high: close + 0.8, low: close - 0.8, close, volume: 1000 });
  }
  const lastHigh = structure(c, 3, 3).lastHigh.price;
  const bk = lastHigh * 1.03;
  c.push({ time: n, open: lastHigh, high: bk + 1, low: lastHigh - 0.5, close: bk, volume: 4000 });
  return c;
}

test("rejects when there is not enough history", () => {
  const r = evaluate([{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }], 10000);
  assert.equal(r.action, "NO_TRADE");
  assert.match(r.reason, /history/i);
});

test("emits a BUY on a confirmed volume-backed BOS in an uptrend", () => {
  const r = evaluate(uptrendBreakout(), 10000, {});
  assert.equal(r.action, "BUY");
  assert.ok(r.shares >= 1);
  assert.ok(r.stop < r.entry, "long stop sits below entry");
  assert.ok(r.riskReward >= 2 - 1e-9, "reward:risk >= minRR");
});

test("position size never exceeds the 15% per-name cap", () => {
  const equity = 10000;
  const r = evaluate(uptrendBreakout(), equity, { riskPct: 0.05 }); // big risk budget
  assert.equal(r.action, "BUY");
  assert.equal(r.cappedByPct, true, "cap, not risk, set the size");
  assert.ok(r.notional <= 0.15 * equity + 1e-6, `notional ${r.notional} within 15% of ${equity}`);
});

test("rejects a name too expensive to hold within the cap", () => {
  // One share priced above 15% of equity can't be sized within the cap.
  const c = uptrendBreakout();
  const r = evaluate(c, 500, { riskPct: 0.01 }); // 15% of $500 = $75; price ~$150 > cap
  assert.equal(r.action, "NO_TRADE");
  assert.match(r.reason, /cap|too expensive|too small/i);
});

test("default risk sizing stays well under the cap on a normal book", () => {
  const r = evaluate(uptrendBreakout(), 10000, {});
  assert.equal(r.cappedByPct, false);
  assert.ok(r.notional < 0.15 * 10000);
});
