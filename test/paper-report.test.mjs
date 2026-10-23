// Paper P&L is computed from decision-log records only. No broker is imported.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paperPnlReport, formatPaperPnlReport } from "../js/paper-report.mjs";
import { createDecisionLog } from "../js/decision-log.mjs";

test("replays ENTER, SCALE_OUT, and EXIT from a decision log into realized P&L", () => {
  const log = createDecisionLog({ path: tmpJsonl() });
  log.append({ kind: "ENTER", symbol: "AAA", side: "LONG", shares: 10, entry: 100, dryRun: true, placed: false });
  log.append({ kind: "SCALE_OUT", symbol: "AAA", side: "LONG", shares: 4, price: 110, dryRun: true, placed: false });
  log.append({ kind: "EXIT", symbol: "AAA", side: "LONG", shares: 6, price: 90, dryRun: true, placed: false });
  // Noise the report must ignore.
  log.append({ kind: "SKIP", symbol: "BBB", reason: "guard", dryRun: true });
  log.append({ kind: "NO_TRADE", symbol: "CCC", dryRun: true });
  log.append({ kind: "SENT", symbol: "DDD", live: true, side: "buy", shares: 100, price: 1 });

  const report = paperPnlReport(log);
  // (110-100)*4 + (90-100)*6 = 40 + -60
  assert.equal(report.realizedPnl, -20);
  assert.equal(report.closedTrades.length, 2);
  assert.equal(report.closedTrades[0].pnl, 40);
  assert.equal(report.closedTrades[1].pnl, -60);
  assert.equal(report.openPositions.length, 0);
  assert.equal(report.bySymbol.AAA.realizedPnl, -20);
  assert.equal(report.counted, 3);
});

test("open paper positions are marked when a price is supplied", () => {
  const report = paperPnlReport([
    { kind: "ENTER", symbol: "ccc", side: "LONG", shares: "2", entry: "10", dryRun: "true" },
  ], { marks: { CCC: 15 } });
  assert.equal(report.realizedPnl, 0);
  assert.equal(report.unrealizedPnl, 10);
  assert.equal(report.totalPnl, 10);
  assert.equal(report.openPositions[0].symbol, "CCC");
  assert.equal(report.openPositions[0].shares, 2);
  assert.equal(report.openPositions[0].mark, 15);
});

test("live-mode rows and withheld live attempts are not paper trades", () => {
  const report = paperPnlReport([
    { kind: "ENTER", symbol: "AAA", side: "LONG", shares: 10, entry: 100, dryRun: false, placed: true },
    { kind: "EXIT", symbol: "AAA", side: "LONG", shares: 10, price: 150, pnl: 500, dryRun: false, placed: true },
    { kind: "ENTER", symbol: "BBB", side: "LONG", shares: 10, entry: 20, dryRun: false, placed: false },
    { kind: "ENTER", symbol: "CCC", side: "LONG", shares: 1, entry: 5, dryRun: "false", placed: "true" },
  ]);
  assert.equal(report.counted, 0);
  assert.equal(report.realizedPnl, 0);
  assert.equal(report.openPositions.length, 0);
});

test("average cost across two buys, then a partial sell", () => {
  const report = paperPnlReport([
    { kind: "PAPER_FILL", symbol: "AAA", side: "LONG", order_side: "buy", shares: 10, price: 100 },
    { kind: "PAPER_FILL", symbol: "AAA", side: "LONG", order_side: "buy", shares: 10, price: 120 },
    { kind: "PAPER_FILL", symbol: "AAA", side: "LONG", order_side: "sell", shares: 10, price: 130 },
  ]);
  assert.equal(report.realizedPnl, 200);
  assert.equal(report.closedTrades[0].entry, 110);
  assert.equal(report.openPositions.length, 1);
  assert.equal(report.openPositions[0].shares, 10);
  assert.equal(report.openPositions[0].avgPrice, 110);
});

test("shorts and sells with no position are warnings, not a fabricated book", () => {
  const report = paperPnlReport([
    { kind: "ENTER", symbol: "AAA", side: "SHORT", shares: 5, entry: 100, dryRun: true },
    { kind: "EXIT", symbol: "BBB", side: "LONG", shares: 1, price: 10, dryRun: true },
  ]);
  assert.equal(report.realizedPnl, 0);
  assert.equal(report.openPositions.length, 0);
  assert.ok(report.warnings.some((w) => w.reason === "short-not-allowed"));
  assert.ok(report.warnings.some((w) => w.reason === "sell-without-position"));
});

test("formatPaperPnlReport is a stable text rendering of the log", () => {
  const report = paperPnlReport([
    { kind: "ENTER", symbol: "AAA", side: "LONG", shares: 10, entry: 100, dryRun: true },
    { kind: "EXIT", symbol: "AAA", side: "LONG", shares: 10, price: 110, dryRun: true },
  ]);
  const text = formatPaperPnlReport(report);
  assert.match(text, /^Paper P&L/);
  assert.match(text, /realized: \$100\.00/);
  assert.match(text, /AAA 10 @ 100 -> 110  pnl \$100\.00/);
  assert.match(text, /open:\n {2}\(none\)/);
});

const tmp = [];
function tmpJsonl() {
  const p = path.join(os.tmpdir(), `paper-report-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  tmp.push(p);
  return p;
}
after(() => { for (const p of tmp) { try { fs.unlinkSync(p); } catch {} } });
