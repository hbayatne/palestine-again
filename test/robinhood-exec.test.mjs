// Tests for the Robinhood execution adapter and its integration with the loop.
// The whole point: prove that NO order reaches the broker in dry-run, and NO
// buy reaches the broker without explicit approval — at the adapter level AND
// end-to-end through the live loop (two independent gates).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRobinhoodExecutor, buildOrder, LIVE_TRADING_ENV, LIVE_TRADING_PHRASE } from "../js/robinhood-exec.mjs";
import { paperPnlReport } from "../js/paper-report.mjs";
import { runCycle } from "../js/live-loop.mjs";
import * as guard from "../js/risk-guard.js";
import { createDecisionLog } from "../js/decision-log.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The live path reads process.env at call time. Isolate mutations so one test
// cannot arm (or disarm) another.
async function withLiveArm(phrase, fn) {
  const prev = process.env[LIVE_TRADING_ENV];
  if (phrase === undefined) delete process.env[LIVE_TRADING_ENV];
  else process.env[LIVE_TRADING_ENV] = phrase;
  try { return await fn(); }
  finally {
    if (prev === undefined) delete process.env[LIVE_TRADING_ENV];
    else process.env[LIVE_TRADING_ENV] = prev;
  }
}

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
  const res = await withLiveArm(LIVE_TRADING_PHRASE, () => ex.execute(enter({ approved: true })));
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
  const r1 = await withLiveArm(LIVE_TRADING_PHRASE, () => ex.execute(enter({ approved: false })));
  const r2 = await withLiveArm(LIVE_TRADING_PHRASE, () => ex.execute(enter())); // approved undefined
  assert.equal(b.sent.length, 0, "no unapproved buy ever sent");
  assert.equal(r1.blocked, "unapproved-buy");
  assert.equal(r2.blocked, "unapproved-buy");
});

test("live SHORT entry is refused (cash account cannot short)", async () => {
  const b = mockBroker();
  const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, accountNumber: "ACC", live: true });
  const res = await withLiveArm(LIVE_TRADING_PHRASE, () =>
    ex.execute({ type: "ENTER", symbol: "AAA", side: "SHORT", shares: 5, entry: 100, approved: true }));
  assert.equal(b.sent.length, 0);
  assert.equal(res.blocked, "short-not-allowed");
});

test("live EXIT (sell) is allowed without approval and maps to a sell", async () => {
  const b = mockBroker();
  const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, accountNumber: "ACC", live: true });
  const res = await withLiveArm(LIVE_TRADING_PHRASE, () =>
    ex.execute({ type: "EXIT", symbol: "AAA", side: "LONG", shares: 10, price: 95 }));
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].side, "sell");
  assert.equal(b.sent[0].type, "market");
  assert.equal(res.placed, true);
});

test("live but no account number: refuses rather than guessing", async () => {
  const b = mockBroker();
  const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, live: true }); // no accountNumber
  const res = await withLiveArm(LIVE_TRADING_PHRASE, () => ex.execute(enter({ approved: true })));
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
  await withLiveArm(LIVE_TRADING_PHRASE, () => runCycle(loopDeps(b, { live: true }, async () => true), ["AAA"],
    state, cfg, { mode: "execute", dryRun: false, evaluate: buySignal() }));
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].side, "buy");
  assert.equal(b.sent[0].symbol, "AAA");
  assert.equal(state.openPositions.length, 1);
});

// ---- Live latch + paper default -------------------------------------------

test("the arming phrase is exactly ALLOW_LIVE_TRADING=I_UNDERSTAND", () => {
  assert.equal(LIVE_TRADING_ENV, "ALLOW_LIVE_TRADING");
  assert.equal(LIVE_TRADING_PHRASE, "I_UNDERSTAND");
});

test("default mode never calls placeEquityOrder, even if it was injected", async () => {
  await withLiveArm(undefined, async () => {
    const b = mockBroker();
    const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, accountNumber: "ACC" });
    const res = await ex.execute(enter({ approved: true }));
    assert.equal(b.sent.length, 0, "injected placeEquityOrder was called in default mode");
    assert.equal(res.placed, false);
    assert.equal(res.paper, true);
    assert.equal(res.dryRun, true);
    const snap = ex.paper.snapshot();
    assert.equal(snap.positions.length, 1);
    assert.equal(snap.positions[0].symbol, "AAA");
    assert.equal(snap.positions[0].shares, 10);
    assert.equal(snap.fills.length, 1);
    assert.equal(snap.fills[0].paper, true);
  });
});

test("default mode ignores a paper broker that is actually the live hook", async () => {
  await withLiveArm(undefined, async () => {
    const b = mockBroker();
    const ex = createRobinhoodExecutor({
      placeEquityOrder: b.placeEquityOrder,
      paper: b,
      accountNumber: "ACC",
    });
    const res = await ex.execute(enter({ approved: true }));
    assert.equal(b.sent.length, 0);
    assert.equal(res.paper, true);
    assert.equal(ex.paper.snapshot().fills.length, 1);
    assert.notEqual(ex.paper.placeEquityOrder, b.placeEquityOrder);
  });
});

test("the arming phrase alone does not call placeEquityOrder while live is off", async () => {
  await withLiveArm(LIVE_TRADING_PHRASE, async () => {
    const b = mockBroker();
    const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, accountNumber: "ACC" });
    await ex.execute(enter({ approved: true }));
    assert.equal(b.sent.length, 0);
    assert.equal(ex.paper.snapshot().fills.length, 1);
  });
});

test("live path throws unless ALLOW_LIVE_TRADING=I_UNDERSTAND and never calls placeEquityOrder", async () => {
  const phrases = [undefined, "", "true", "1", "yes", "i_understand", "I_UNDERSTAND_NOT"];
  for (const phrase of phrases) {
    await withLiveArm(phrase, async () => {
      const b = mockBroker();
      let called = false;
      b.placeEquityOrder = async (o) => { called = true; b.sent.push(o); return o; };
      const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, accountNumber: "ACC", live: true });
      await assert.rejects(
        () => ex.execute(enter({ approved: true })),
        (err) => {
          assert.equal(err.code, "LIVE_TRADING_LOCKED");
          assert.match(err.message, /ALLOW_LIVE_TRADING/);
          assert.match(err.message, /placeEquityOrder was not called/);
          return true;
        }
      );
      assert.equal(called, false);
      assert.equal(b.sent.length, 0);
      assert.equal(ex.paper.snapshot().fills.length, 0, "a locked live attempt is not paper-filled");
    });
  }
});

test("armed live path does not also paper-fill", async () => {
  await withLiveArm(LIVE_TRADING_PHRASE, async () => {
    const b = mockBroker();
    const ex = createRobinhoodExecutor({ placeEquityOrder: b.placeEquityOrder, accountNumber: "ACC", live: true });
    const res = await ex.execute(enter({ approved: true }));
    assert.equal(res.placed, true);
    assert.equal(b.sent.length, 1);
    assert.equal(ex.paper.snapshot().fills.length, 0);
    assert.equal(ex.paper.snapshot().positions.length, 0);
  });
});

test("default mode paper round-trip writes a decision log the P&L report can read", async () => {
  await withLiveArm(undefined, async () => {
    const b = mockBroker();
    const logPath = path.join(os.tmpdir(), `paper-pnl-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    const audit = createDecisionLog({ path: logPath });
    try {
      const ex = createRobinhoodExecutor({
        placeEquityOrder: b.placeEquityOrder, accountNumber: "ACC", audit,
      });
      await ex.execute(enter({ approved: true }));
      await ex.execute({ type: "EXIT", symbol: "AAA", side: "LONG", shares: 10, price: 110 });
      assert.equal(b.sent.length, 0, "placeEquityOrder must not run while the paper book is marked");
      const report = paperPnlReport(audit);
      assert.equal(report.realizedPnl, 100);
      assert.equal(report.openPositions.length, 0);
      assert.equal(report.closedTrades.length, 1);
      assert.equal(report.closedTrades[0].symbol, "AAA");
      assert.equal(report.closedTrades[0].entry, 100);
      assert.equal(report.closedTrades[0].exit, 110);
      assert.equal(paperPnlReport(audit.readAll()).realizedPnl, 100);
    } finally {
      try { fs.unlinkSync(logPath); } catch {}
    }
  });
});
