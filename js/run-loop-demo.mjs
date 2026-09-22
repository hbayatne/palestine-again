// run-loop-demo.mjs
// Exercises the live loop in SAFE "propose" mode against synthetic candles, with
// fully-wired multi-timeframe data and the risk guard. Proves the whole stack —
// mtf gating, per-trade sizing, portfolio guards, position management — runs
// end-to-end without a broker. Run: node js/run-loop-demo.mjs
import { runCycle } from "./live-loop.mjs";
import * as guard from "./risk-guard.js";

// synthetic candle generator with a tunable trend so we can build aligned HTFs
function series(n, seed, drift, impulse = false) {
  let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const c = []; let price = 100;
  for (let i = 0; i < n; i++) {
    let d = drift;
    if (impulse && i % 30 < 5) d = 0.02;          // periodic poles on entry TF
    else if (impulse && i % 30 < 14) d = -0.001;  // flags
    const ret = d + (rnd() - 0.5) * 0.01;
    const open = price, close = Math.max(1, price * (1 + ret));
    const high = Math.max(open, close) * (1 + rnd() * 0.005);
    const low = Math.min(open, close) * (1 - rnd() * 0.005);
    c.push({ time: i, open: r(open), high: r(high), low: r(low), close: r(close),
      volume: Math.round(1000 * (impulse && i % 30 < 5 ? 2.2 : 0.9) * (0.8 + rnd() * 0.4)) });
    price = close;
  }
  return c;
}
const r = (v) => Math.round(v * 100) / 100;

// Build an uptrending book across all timeframes for two symbols.
const data = {
  AAA: { entry: series(200, 3, 0.001, true), daily: series(220, 11, 0.002), weekly: series(160, 21, 0.003) },
  BBB: { entry: series(200, 5, 0.001, true), daily: series(220, 13, -0.002), weekly: series(160, 23, -0.002) }, // daily DOWN → should be filtered
};

const cfg = guard.defaultConfig(1000);
let state = guard.newState(1000);

const deps = {
  getEquity: async () => 1000,
  fetchCandles: async (sym, tf) => data[sym][tf],
  execute: async () => {}, // unused in propose mode
  log: (m) => console.log("  " + m),
};

console.log("\n=== Live loop — SAFE propose mode ===");
console.log(`config: ${JSON.stringify(cfg)}\n`);
const res = await runCycle(deps, ["AAA", "BBB"], state, cfg, { mode: "propose" });

console.log("\n=== Proposed actions ===");
if (!res.actions.length) console.log("  (none this cycle)");
for (const a of res.actions) {
  if (a.type === "ENTER") console.log(`  ENTER ${a.symbol} ${a.side} x${a.shares} @ ${a.entry} stop ${a.stop} tgt ${a.target} | conf ${a.confidence} | ${a.setup}`);
  else console.log(`  EXIT ${a.symbol} @ ${a.price} (${a.reason}) pnl ${a.pnl}`);
}

// demonstrate the daily loss cap tripping
console.log("\n=== Guard demo: daily loss cap ===");
const s2 = guard.newState(1000);
console.log("  fresh:", guard.canTrade(s2, cfg, 1000).reason);
console.log("  after -3.5% day:", guard.canTrade(s2, cfg, 965).reason);
console.log("  kill switch:", guard.canTrade(guard.trip(guard.newState(1000), "manual test"), cfg, 1000).reason);
console.log();
