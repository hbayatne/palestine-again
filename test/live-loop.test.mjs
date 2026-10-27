// Tests for the live-loop SAFETY RAILS: paper/dry-run default, the human
// approval gate on buys, risk-reducing exits, cash-floor wiring, and the
// decision audit log. The signal engine is stubbed so these tests isolate the
// rails (the strategy itself is covered in strategy.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCycle } from "../js/live-loop.mjs";
import * as guard from "../js/risk-guard.js";
import { nullLog } from "../js/decision-log.mjs";

const cfg = guard.defaultConfig(10000);

// A canned BUY that comfortably clears every cap (10% of a $10k book).
function buySignal(over = {}) {
  return async () => ({
    action: "BUY", setup: "bull_flag", shares: 10, entry: 100, stop: 95, target: 115,
    notional: 1000, riskDollars: 100, confidence: 70, plan: "LONG 10 @ 100", ...over,
  });
}
const candle = (o) => ({ time: 0, open: 100, high: 101, low: 99, close: 100, volume: 1000, ...o });

function baseDeps(over = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      getEquity: async () => 10000,
      getCash: async () => 10000,
      fetchCandles: async () => [candle()],
      execute: async (a) => { calls.push(a); },
      decisionLog: nullLog(),
      log: () => {},
      ...over,
    },
  };
}

test("propose mode (default) never executes a buy", async () => {
  const { deps, calls } = baseDeps();
  const res = await runCycle(deps, ["AAA"], guard.newState(10000), cfg,
    { evaluate: buySignal() });
  assert.equal(calls.length, 0);
  assert.equal(res.dryRun, true);
  const enter = res.actions.find((a) => a.type === "ENTER");
  assert.ok(enter);
  assert.equal(enter.status, "PROPOSED");
});

test("dryRun stays ON even in execute mode unless explicitly disabled", async () => {
  const { deps, calls } = baseDeps();
  const res = await runCycle(deps, ["AAA"], guard.newState(10000), cfg,
    { mode: "execute", evaluate: buySignal() });   // dryRun not set -> defaults ON
  assert.equal(res.dryRun, true);
  assert.equal(calls.length, 0, "no execute while paper/dry-run is on");
});

test("execute + dryRun:false but NO approver => buy is NOT placed (awaits approval)", async () => {
  const { deps, calls } = baseDeps();
  const res = await runCycle(deps, ["AAA"], guard.newState(10000), cfg,
    { mode: "execute", dryRun: false, evaluate: buySignal() });
  assert.equal(calls.length, 0);
  const enter = res.actions.find((a) => a.type === "ENTER");
  assert.equal(enter.status, "AWAITING_APPROVAL");
});

test("execute + dryRun:false + approver YES => buy is placed and recorded", async () => {
  const { deps, calls } = baseDeps({ approve: async () => true });
  const state = guard.newState(10000);
  await runCycle(deps, ["AAA"], state, cfg,
    { mode: "execute", dryRun: false, evaluate: buySignal() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "ENTER");
  assert.equal(state.openPositions.length, 1);
  assert.equal(state.openPositions[0].symbol, "AAA");
});

test("approver NO => buy is not placed", async () => {
  const { deps, calls } = baseDeps({ approve: async () => false });
  const state = guard.newState(10000);
  await runCycle(deps, ["AAA"], state, cfg,
    { mode: "execute", dryRun: false, evaluate: buySignal() });
  assert.equal(calls.length, 0);
  assert.equal(state.openPositions.length, 0);
});

test("an approver that throws fails CLOSED (no buy)", async () => {
  const { deps, calls } = baseDeps({ approve: async () => { throw new Error("boom"); } });
  await runCycle(deps, ["AAA"], guard.newState(10000), cfg,
    { mode: "execute", dryRun: false, evaluate: buySignal() });
  assert.equal(calls.length, 0);
});

test("exits (risk-reducing) execute WITHOUT an approver when live", async () => {
  const state = guard.newState(10000);
  guard.recordEntry(state, { symbol: "AAA", side: "LONG", shares: 10, entry: 100,
    stop: 98, initialStop: 98, riskPerShare: 2, target: 120, beMoved: false, scaledOut: false });
  // candle gaps below the stop -> exit should fire
  const { deps, calls } = baseDeps({
    fetchCandles: async () => [candle({ high: 97, low: 90, close: 95 })],
  });
  await runCycle(deps, [], state, cfg,
    { mode: "execute", dryRun: false, evaluate: buySignal() });
  const exit = calls.find((c) => c.type === "EXIT");
  assert.ok(exit, "exit executed without approval");
  assert.equal(state.openPositions.length, 0);
});

test("dryRun blocks exits too (paper mode is fully inert)", async () => {
  const state = guard.newState(10000);
  guard.recordEntry(state, { symbol: "AAA", side: "LONG", shares: 10, entry: 100,
    stop: 98, initialStop: 98, riskPerShare: 2, target: 120 });
  const { deps, calls } = baseDeps({
    fetchCandles: async () => [candle({ high: 97, low: 90, close: 95 })],
  });
  await runCycle(deps, [], state, cfg, { evaluate: buySignal() }); // propose/dryRun
  assert.equal(calls.length, 0);
  assert.equal(state.openPositions.length, 1, "position not closed in paper mode");
});

test("30% cash floor is enforced by the loop (blocks the buy)", async () => {
  // cash 3500, buy 1000 -> 2500 left < 30% of 10000 ($3000) -> blocked
  const { deps, calls } = baseDeps({ getCash: async () => 3500, approve: async () => true });
  const res = await runCycle(deps, ["AAA"], guard.newState(10000), cfg,
    { mode: "execute", dryRun: false, evaluate: buySignal() });
  assert.equal(calls.length, 0, "cash-floor breach blocks execution");
  assert.ok(!res.actions.find((a) => a.type === "ENTER"), "no ENTER action emitted");
});

test("15% per-name cap is enforced by the loop (blocks oversized buy)", async () => {
  // notional 2000 = 20% of 10000 -> blocked by per-name cap
  const { deps, calls } = baseDeps({ approve: async () => true });
  const res = await runCycle(deps, ["AAA"], guard.newState(10000), cfg,
    { mode: "execute", dryRun: false, evaluate: buySignal({ notional: 2000 }) });
  assert.equal(calls.length, 0);
  assert.ok(!res.actions.find((a) => a.type === "ENTER"));
});

test("every decision is written to the append-only audit log", async () => {
  const audit = nullLog();
  const { deps } = baseDeps({ decisionLog: audit, approve: async () => true });
  await runCycle(deps, ["AAA"], guard.newState(10000), cfg,
    { mode: "execute", dryRun: false, evaluate: buySignal() });
  const rows = audit.readAll();
  const enter = rows.find((r) => r.kind === "ENTER");
  assert.ok(enter, "ENTER decision logged");
  assert.equal(enter.approved, true);
  assert.equal(enter.placed, true);
  assert.equal(enter.dryRun, false);
});

test("daily -3% loss halts the scan before any buy (hard stop)", async () => {
  const state = guard.newState(10000);
  const { deps, calls } = baseDeps({
    getEquity: async () => 9600,          // -4% on the day
    approve: async () => true,
  });
  const res = await runCycle(deps, ["AAA", "BBB"], state, cfg,
    { mode: "execute", dryRun: false, evaluate: buySignal() });
  assert.equal(calls.length, 0);
  const skips = res.actions.filter((a) => a.type === "ENTER");
  assert.equal(skips.length, 0);
});
