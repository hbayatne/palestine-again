// Tests for the Robinhood execution adapter and its integration with the loop.
// The whole point: prove that NO order reaches the broker in dry-run, and NO
// buy reaches the broker without explicit approval — at the adapter level AND
// end-to-end through the live loop (two independent gates).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRobinhoodExecutor, buildOrder } from "../js/robinhood-exec.mjs";
import { runCycle } from "../js/live-loop.mjs";
import * as guard from "../js/risk-guard.js";

// A broker mock that records every call. If the engine is correct, this stays
// empty except in the exact live+approved paths.
function mockBroker() {
  const sent = [];
  return { sent, placeEquityOrder: async (o) => { sent.push(o); return { id: "mock", state: "queued", ...o }; } };
}

const enter = (over = {}) => ({ type: "ENTER", symbol: "AAA", side: "LONG", shares: 10,
  entry: 100, stop: 95, target: 115, ...over });

// ---- Adapter-level gates --------------------------------------------------

test("DEFAULT is dry-run: an approved buy is NOT sent to the broker", async () => {
  const b = mockBroker();
  const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, accountNumber: "ACC" });
  const res = await ex.execute(enter({ approved: true }));
  assert.equal(b.sent.length, 0, "broker never called in dry-run");
  assert.equal(res.dryRun, true);
  assert.ok(res.wouldSend, "returns the order it would have sent, for inspection");
});

test("live + approved BUY sends exactly one correctly-mapped order", async () => {
  const b = mockBroker();
  const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, accountNumber: "ACC", live: true });
  const res = await ex.execute(enter({ approved: true }));
  assert.equal(b.sent.length, 1);
  const o = b.sent[0];
  assert.equal(o.side, "buy");
  assert.equal(o.type, "limit");
  assert.equal(o.symbol, "AAA");
  assert.equal(o.quantity, "10");
  assert.equal(o.limit_price, "100");
  assert.equal(o.account_number, "ACC");
  assert.ok(o.ref_id, "has an idempotency key");
  assert.equal(res.placed, true);
});

test("live BUY without approval is REFUSED (adapter defense-in-depth)", async () => {
  const b = mockBroker();
  const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, accountNumber: "ACC", live: true });
  const r1 = await ex.execute(enter({ approved: false }));
  const r2 = await ex.execute(enter());               // approved undefined
  assert.equal(b.sent.length, 0, "no unapproved buy ever sent");
  assert.equal(r1.blocked, "unapproved-buy");
  assert.equal(r2.blocked, "unapproved-buy");
});

test("live SHORT entry is refused (cash account cannot short)", async () => {
  const b = mockBroker();
  const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, accountNumber: "ACC", live: true });
  const res = await ex.execute({ type: "ENTER", symbol: "AAA", side: "SHORT", shares: 5, entry: 100, approved: true });
  assert.equal(b.sent.length, 0);
  assert.equal(res.blocked, "short-not-allowed");
});

test("live EXIT (sell) is allowed without approval and maps to a sell", async () => {
  const b = mockBroker();
  const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, accountNumber: "ACC", live: true });
  const res = await ex.execute({ type: "EXIT", symbol: "AAA", side: "LONG", shares: 10, price: 95 });
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].side, "sell");
  assert.equal(b.sent[0].type, "market");
  assert.equal(res.placed, true);
});

test("live but no account number: refuses rather than guessing", async () => {
  const b = mockBroker();
  const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, live: true }); // no accountNumber
  const res = await ex.execute(enter({ approved: true }));
  assert.equal(b.sent.length, 0);
  assert.equal(res.blocked, "no-account-number");
});

test("buildOrder maps entry/exit shapes and always has a ref_id", () => {
  const buy = buildOrder(enter(), { accountNumber: "ACC", entryType: "limit" });
  assert.equal(buy.side, "buy"); assert.equal(buy.limit_price, "100"); assert.ok(buy.ref_id);
  const exit = buildOrder({ type: "EXIT", symbol: "AAA", side: "LONG", shares: 10, price: 95 },
    { accountNumber: "ACC", exitType: "market" });
  assert.equal(exit.side, "sell"); assert.equal(exit.type, "market");
});

// ---- End-to-end through the loop: the two gates are independent -----------

const cfg = guard.defaultConfig(10000);
const buySignal = () => async () => ({ action: "BUY", setup: "bull_flag", shares: 10, entry: 100,
  stop: 95, target: 115, notional: 1000, riskDollars: 100, confidence: 70, plan: "LONG 10 @ 100" });
const candle = { time: 0, open: 100, high: 101, low: 99, close: 100, volume: 1000 };

function loopDeps(broker, exOpts, approve) {
  const ex = createRobinhoodExecutor({ placeEquityOrder: broker.placeEquityOrder, accountNumber: "ACC", ...exOpts });
  return { getEquity: async () => 10000, getCash: async () => 10000,
    fetchCandles: async () => [candle], execute: ex.execute, approve, log: () => {} };
}

test("loop dry-run ON: broker never called even if adapter is live", async () => {
  const b = mockBroker();
  await runCycle(loopDeps(b, { live: true }, async () => true), ["AAA"],
    guard.newState(10000), cfg, { evaluate: buySignal() }); // propose/dryRun default
  assert.equal(b.sent.length, 0);
});

test("loop live + approved but adapter dry-run: broker still never called", async () => {
  const b = mockBroker();
  await runCycle(loopDeps(b, { live: false }, async () => true), ["AAA"],
    guard.newState(10000), cfg, { mode: "execute", dryRun: false, evaluate: buySignal() });
  assert.equal(b.sent.length, 0, "adapter dry-run is a second independent gate");
});

test("loop live + NO approver + adapter live: broker never called (buy withheld)", async () => {
  const b = mockBroker();
  await runCycle(loopDeps(b, { live: true }, undefined), ["AAA"],
    guard.newState(10000), cfg, { mode: "execute", dryRun: false, evaluate: buySignal() });
  assert.equal(b.sent.length, 0);
});

test("loop live + approver YES + adapter live: exactly one buy reaches the broker", async () => {
  const b = mockBroker();
  const state = guard.newState(10000);
  await runCycle(loopDeps(b, { live: true }, async () => true), ["AAA"],
    state, cfg, { mode: "execute", dryRun: false, evaluate: buySignal() });
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].side, "buy");
  assert.equal(b.sent[0].symbol, "AAA");
  assert.equal(state.openPositions.length, 1);
});
