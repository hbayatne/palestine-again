// scan.mjs
// Level-2 demo: run the strategy engine over REAL Robinhood candle data and
// print a scan verdict per symbol. Reads a get_equity_historicals result file
// (the {data:{results:[{symbol,bars:[...]}]}} shape the MCP tool returns) so the
// exact same engine that would run live can be shown on saved data.
//
//   node js/scan.mjs <historicals.json> [equity]
//
// Each result's bars use open_price/high_price/low_price/close_price/volume/
// begins_at; we map them to the engine's {time,open,high,low,close,volume}.

import { readFileSync } from "node:fs";
import { evaluate } from "./strategy.js";
import { htfTrend } from "./mtf.js";

const file = process.argv[2];
const equity = Number(process.argv[3] || 1000);
if (!file) { console.error("usage: node js/scan.mjs <historicals.json> [equity]"); process.exit(1); }

const raw = JSON.parse(readFileSync(file, "utf8"));
const results = raw?.data?.results || [];

function toCandles(bars) {
  return bars
    .filter((b) => !b.interpolated) // skip gap-fill bars — no real info
    .map((b) => ({
      time: b.begins_at,
      open: +b.open_price, high: +b.high_price,
      low: +b.low_price, close: +b.close_price,
      volume: +b.volume,
    }));
}

console.log(`\n=== Strategy scan (equity $${equity}) — ${results.length} symbols ===\n`);
for (const r of results) {
  const candles = toCandles(r.bars || []);
  if (candles.length < 60) { console.log(`${r.symbol.padEnd(6)} — only ${candles.length} bars, need 60+`); continue; }
  const trend = htfTrend(candles);
  const sig = evaluate(candles, equity);
  const last = candles[candles.length - 1].close;

  const head = `${r.symbol.padEnd(6)} $${last.toFixed(2).padStart(8)}  trend:${trend.padEnd(6)}`;
  if (sig.action === "NO_TRADE") {
    console.log(`${head}  →  NO TRADE`);
    console.log(`        ${sig.reason}`);
  } else {
    console.log(`${head}  →  ${sig.action}  (conf ${sig.confidence}, R:R ${sig.riskReward})`);
    console.log(`        ${sig.plan}`);
  }
}
console.log();
