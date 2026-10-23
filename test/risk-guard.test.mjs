// Tests for the portfolio-level circuit breakers and the new safety rails:
// 3% daily max-loss kill, 15% per-name cap, 30% cash floor, drawdown kill,
// intraday peak ratcheting, and the hard/soft halt classification.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as guard from "../js/risk-guard.js";

const cfg = guard.defaultConfig(1000);

test("defaultConfig exposes the required rails", () => {
  assert.equal(cfg.dailyLossCapPct, 0.03);
  assert.equal(cfg.maxPositionPct, 0.15);
  assert.equal(cfg.minCashPct, 0.30);
  assert.equal(cfg.maxDrawdownPct, 0.15);
});

test("fresh state can trade", () => {
  const s = guard.newState(1000);
  const r = guard.canTrade(s, cfg, 1000, { symbol: "AAA" });
  assert.equal(r.ok, true);
});

test("daily max-loss kill switch: halts new buys at -3% on the day (HARD)", () => {
  const s = guard.newState(1000);
  assert.equal(guard.canTrade(s, cfg, 971, { symbol: "AAA" }).ok, true);   // -2.9% ok
  const hit = guard.canTrade(s, cfg, 969, { symbol: "AAA" });              // -3.1% halt
  assert.equal(hit.ok, false);
  assert.equal(hit.hard, true);
  assert.match(hit.reason, /Daily loss cap/);
});

test("15% per-name cap blocks an oversized position (SOFT)", () => {
  const s = guard.newState(1000);
  // 14% ok, 16% blocked
  assert.equal(guard.canTrade(s, cfg, 1000, { symbol: "AAA", notional: 140 }).ok, true);
  const blocked = guard.canTrade(s, cfg, 1000, { symbol: "AAA", notional: 160 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.hard, false);
  assert.match(blocked.reason, /per-name cap/);
});

test("15% per-name cap counts value already held in the name", () => {
  const s = guard.newState(1000);
  // new $80 + already-held $90 = $170 = 17% > 15%
  const blocked = guard.canTrade(s, cfg, 1000, { symbol: "AAA", notional: 80, heldValue: 90 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /per-name cap/);
});

test("30% cash floor blocks a buy that would breach it (SOFT)", () => {
  const s = guard.newState(1000);
  // equity 1000, floor = 300. cash 350, buy 120 -> 230 left -> blocked.
  const blocked = guard.canTrade(s, cfg, 1000, { symbol: "AAA", notional: 120, cash: 350 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.hard, false);
  assert.match(blocked.reason, /cash/i);
  // cash 500, buy 120 -> 380 left -> ok
  assert.equal(guard.canTrade(s, cfg, 1000, { symbol: "AAA", notional: 120, cash: 500 }).ok, true);
});

test("cash floor is skipped when cash is not supplied (opt-in)", () => {
  const s = guard.newState(1000);
  assert.equal(guard.canTrade(s, cfg, 1000, { symbol: "AAA", notional: 140 }).ok, true);
});

test("max drawdown from peak trips a HARD auto-halt", () => {
  const s = guard.newState(1000);
  s.peakEquity = 1000;
  const r = guard.canTrade(s, cfg, 840, { symbol: "AAA" }); // -16% from peak
  assert.equal(r.ok, false);
  assert.equal(r.hard, true);
  assert.match(r.reason, /drawdown/i);
});

test("markEquity ratchets the intraday peak so drawdown is measured from the high", () => {
  const s = guard.newState(1000);
  guard.markEquity(s, 1200);                 // pumped intraday, never persisted before this fix
  assert.equal(s.peakEquity, 1200);
  const r = guard.canTrade(s, cfg, 1000, { symbol: "AAA" }); // -16.7% from the 1200 peak
  assert.equal(r.ok, false);
  assert.match(r.reason, /drawdown/i);
  guard.markEquity(s, 1100);                 // a lower reading does not lower the peak
  assert.equal(s.peakEquity, 1200);
});

test("no pyramiding into a name already held (SOFT)", () => {
  const s = guard.newState(1000);
  guard.recordEntry(s, { symbol: "AAA", side: "LONG", shares: 1, entry: 10, stop: 9 });
  const r = guard.canTrade(s, cfg, 1000, { symbol: "AAA", notional: 10 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /pyramiding/);
});

test("max concurrent and max trades/day are HARD halts", () => {
  const s = guard.newState(1000);
  s.openPositions = [{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }];
  assert.equal(guard.canTrade(s, cfg, 1000, { symbol: "D" }).hard, true);

  const s2 = guard.newState(1000);
  s2.tradesToday = 5;
  assert.equal(guard.canTrade(s2, cfg, 1000, { symbol: "A" }).hard, true);
});

test("kill switch blocks everything until cleared", () => {
  let s = guard.newState(1000);
  s = guard.trip(s, "data gap");
  const r = guard.canTrade(s, cfg, 1000, { symbol: "A" });
  assert.equal(r.ok, false);
  assert.equal(r.hard, true);
  s = guard.clearKill(s);
  assert.equal(guard.canTrade(s, cfg, 1000, { symbol: "A" }).ok, true);
});

test("rollDay resets daily counters but keeps positions and peak", () => {
  let s = guard.newState(1000, "2026-01-01");
  s.tradesToday = 4; s.realizedPnLToday = -20; s.peakEquity = 1100;
  s.openPositions = [{ symbol: "A" }];
  s = guard.rollDay(s, 1050, "2026-01-02");
  assert.equal(s.tradesToday, 0);
  assert.equal(s.realizedPnLToday, 0);
  assert.equal(s.startOfDayEquity, 1050);
  assert.equal(s.peakEquity, 1100);          // peak persists
  assert.equal(s.openPositions.length, 1);   // positions persist
});
