// run-safety-demo.mjs
// Demonstrates the SAFETY RAILS end-to-end without a broker:
//   1. paper/dry-run is ON by default — nothing executes;
//   2. flipping to live still refuses to buy without explicit human approval;
//   3. the 15%-per-name cap and 30% cash floor block oversized / cash-draining buys;
//   4. every decision lands in an append-only JSONL audit log.
// Run: node js/run-safety-demo.mjs
import { runCycle } from "./live-loop.mjs";
import * as guard from "./risk-guard.js";
import { createDecisionLog } from "./decision-log.mjs";
import { paperPnlReport, formatPaperPnlReport } from "./paper-report.mjs";
import os from "node:os";
import path from "node:path";

// A canned signal engine so the demo is deterministic (the real strategy is
// exercised by run-loop-demo.mjs and the tests).
const buy = (notional = 1000) => async () => ({
  action: "BUY", setup: "bull_flag", shares: Math.round(notional / 100), entry: 100,
  stop: 95, target: 115, notional, riskDollars: 100, confidence: 72, plan: `LONG ~$${notional}`,
});

const EQUITY = 10000;
const cfg = guard.defaultConfig(EQUITY);
const logPath = path.join(os.tmpdir(), `safety-demo-${Date.now()}.jsonl`);
const decisionLog = createDecisionLog({ path: logPath });

const baseDeps = (over = {}) => ({
  getEquity: async () => EQUITY,
  getCash: async () => EQUITY,
  fetchCandles: async () => [{ time: 0, open: 100, high: 101, low: 99, close: 100, volume: 1000 }],
  execute: async (a) => console.log(`    >>> BROKER EXECUTE: ${a.type} ${a.symbol} x${a.shares}`),
  decisionLog,
  log: (m) => console.log("    " + m),
  ...over,
});

console.log("\n=== 1) Default: paper / dry-run ON (nothing executes) ===");
await runCycle(baseDeps(), ["AAA"], guard.newState(EQUITY), cfg, { evaluate: buy(), cycleId: "c1" });

console.log("\n=== 2) Live (dryRun:false) but NO approver — buy is withheld ===");
await runCycle(baseDeps(), ["AAA"], guard.newState(EQUITY), cfg,
  { mode: "execute", dryRun: false, evaluate: buy(), cycleId: "c2" });

console.log("\n=== 3) Live + human approves — buy executes ===");
await runCycle(baseDeps({ approve: async (a) => { console.log(`    [human] approve ${a.symbol}? -> YES`); return true; } }),
  ["AAA"], guard.newState(EQUITY), cfg, { mode: "execute", dryRun: false, evaluate: buy(), cycleId: "c3" });

console.log("\n=== 4) Live + approver, but 15% per-name cap blocks a $2,000 (20%) buy ===");
await runCycle(baseDeps({ approve: async () => true }),
  ["AAA"], guard.newState(EQUITY), cfg, { mode: "execute", dryRun: false, evaluate: buy(2000), cycleId: "c4" });

console.log("\n=== 5) Live + approver, but 30% cash floor blocks the buy (cash $3,500) ===");
await runCycle(baseDeps({ approve: async () => true, getCash: async () => 3500 }),
  ["AAA"], guard.newState(EQUITY), cfg, { mode: "execute", dryRun: false, evaluate: buy(1000), cycleId: "c5" });

console.log("\n=== Append-only audit log ===");
console.log("  " + logPath);
for (const r of decisionLog.readAll())
  console.log(`  [${r.cycle}] ${r.kind} ${r.symbol || ""} approved=${r.approved} placed=${r.placed} :: ${r.reason || r.setup || ""}`);

console.log("\n=== Paper P&L from the decision log ===");
console.log("  (dry-run proposals only; live and withheld rows are excluded)");
console.log(formatPaperPnlReport(paperPnlReport(decisionLog, { marks: { AAA: 100 } }))
  .split("\n").map((l) => "  " + l).join("\n"));
console.log();
