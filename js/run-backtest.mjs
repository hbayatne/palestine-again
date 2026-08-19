// run-backtest.mjs
// Node runner for the breakout / structure strategy.
//
//   node js/run-backtest.mjs                 # smoke test on synthetic candles
//   node js/run-backtest.mjs path/to.json    # backtest real OHLCV candles
//
// Real-candle JSON must be an array of {time,open,high,low,close,volume}. You
// can produce that from the Robinhood MCP `get_equity_historicals` tool (run in
// your authenticated local session) and dump it to a file.

import { readFileSync } from "node:fs";
import { evaluate } from "./strategy.js";
import { backtest } from "./backtest.js";

// --- deterministic synthetic series with real structure: an uptrend that
// prints an impulse "pole", a shallow flag, then breaks out. Enough for a
// smoke test that exercises pivots, patterns, sizing and the backtest loop.
function synth(n = 260, seed = 7) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const c = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    let drift = 0.0006;                       // gentle uptrend
    if (i % 40 < 6) drift = 0.012;            // periodic impulse "poles"
    else if (i % 40 < 18) drift = -0.001;     // then a flag drift
    const vol = 0.9 + (i % 40 < 6 ? 1.4 : (i % 40 < 18 ? -0.3 : 0)); // volume regime
    const ret = drift + (rnd() - 0.5) * 0.012;
    const open = price;
    const close = Math.max(1, price * (1 + ret));
    const high = Math.max(open, close) * (1 + rnd() * 0.006);
    const low = Math.min(open, close) * (1 - rnd() * 0.006);
    c.push({ time: i, open: r(open), high: r(high), low: r(low), close: r(close),
             volume: Math.round(1000 * Math.max(0.2, vol) * (0.8 + rnd() * 0.4)) });
    price = close;
  }
  return c;
}
const r = (v) => Math.round(v * 100) / 100;

const file = process.argv[2];
const candles = file
  ? JSON.parse(readFileSync(file, "utf8"))
  : synth();

console.log(`\nLoaded ${candles.length} candles${file ? ` from ${file}` : " (synthetic smoke test)"}.\n`);

// 1) What does the strategy say on the latest bar?
const sig = evaluate(candles, 1000);
console.log("=== Current signal (equity $1,000) ===");
console.log(sig.action === "NO_TRADE" ? `NO_TRADE — ${sig.reason}` : sig.plan);
if (sig.action !== "NO_TRADE")
  console.log(`  confidence ${sig.confidence} | R:R ${sig.riskReward} | ADX ${sig.adx} | vol ${sig.volumeVsAvg}x`);

// 2) Walk-forward backtest — A/B: fixed stop+target vs. profit-protection.
const fixed = backtest(candles, { equity: 1000, feePct: 0.001, manage: false });
const managed = backtest(candles, { equity: 1000, feePct: 0.001, manage: true });

console.log("\n=== Backtest A/B: fixed exit  vs  breakeven+trail+scale-out ===");
const keys = ["trades", "winRate", "expectancyR", "profitFactor", "maxDrawdownPct", "returnPct"];
console.log(`  ${"metric".padEnd(15)} ${"fixed".padStart(10)} ${"managed".padStart(10)}`);
for (const k of keys)
  console.log(`  ${k.padEnd(15)} ${String(fixed[k]).padStart(10)} ${String(managed[k]).padStart(10)}`);

console.log(`\n  managed trades (last 5 of ${managed.tradeLog.length}):`);
for (const t of managed.tradeLog.slice(-5))
  console.log(`   ${t.side} ${t.setup} @${t.entry} -> ${t.outcome} ${t.exit}${t.scaledOut ? " (scaled)" : ""} | ${t.rMultiple}R | $${t.pnl}`);
console.log();
