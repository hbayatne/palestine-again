// marketData.js — server-side market-data proxy.
//
// Two wins over the browser fetching directly: (1) no CORS proxy needed — the
// server calls Yahoo/Binance directly, removing the flaky public-proxy hop; and
// (2) the FMP API key stays on the server, never shipped to the client.
//
// NOTE: this proxies the same public endpoints the app already uses. Before this
// is exposed to paying subscribers, the redistribution rights for each source
// must be reviewed (see COMPLIANCE / DATA_PROVIDERS). Marked as foundation.
import express from "express";
import { config } from "./config.js";

export const dataRouter = express.Router();

const BINANCE = "https://api.binance.com/api/v3";
const INTERVALS = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w", "1M": "1M" };
const YF_MAP = {
  "15m": { i: "15m", r: "1mo" }, "1h": { i: "60m", r: "3mo" }, "4h": { i: "60m", r: "1y" },
  "1d": { i: "1d", r: "2y" }, "1w": { i: "1wk", r: "5y" }, "1M": { i: "1mo", r: "10y" },
};

const looksLikeCrypto = (s) => /(USDT|USDC|BUSD)$/i.test(s);

async function fromBinance(symbol, interval) {
  const url = `${BINANCE}/klines?symbol=${encodeURIComponent(symbol)}&interval=${INTERVALS[interval] || "1d"}&limit=400`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`binance ${r.status}`);
  const raw = await r.json();
  return raw.map((k) => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

async function fromYahoo(symbol, interval) {
  const m = YF_MAP[interval] || YF_MAP["1d"];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${m.r}&interval=${m.i}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 SignalDesk/0.1" } });
  if (!r.ok) throw new Error(`yahoo ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error("yahoo: no result");
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null) continue;
    out.push({ time: ts[i] * 1000, open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close[i], volume: q.volume?.[i] || 0 });
  }
  return out;
}

dataRouter.get("/candles", async (req, res) => {
  const symbol = String(req.query.symbol || "").toUpperCase();
  const interval = String(req.query.interval || "1d");
  if (!symbol) return res.status(400).json({ error: "symbol_required" });
  try {
    let candles;
    if (looksLikeCrypto(symbol)) {
      candles = await fromBinance(symbol, interval).catch(() => fromYahoo(symbol.replace(/USDT|USDC|BUSD$/i, "-USD"), interval));
    } else {
      candles = await fromYahoo(symbol, interval);
    }
    res.set("Cache-Control", "public, max-age=60");
    res.json({ symbol, interval, source: looksLikeCrypto(symbol) ? "binance/yahoo" : "yahoo", candles });
  } catch (e) {
    res.status(502).json({ error: "fetch_failed", message: e.message });
  }
});

dataRouter.get("/fundamentals", async (req, res) => {
  const symbol = String(req.query.symbol || "").toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol_required" });
  if (!config.fmpApiKey) return res.status(503).json({ error: "fundamentals_unconfigured" });
  try {
    const url = `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(symbol)}&apikey=${config.fmpApiKey}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fmp ${r.status}`);
    const data = await r.json();
    res.set("Cache-Control", "public, max-age=3600");
    res.json({ symbol, profile: Array.isArray(data) ? data[0] : data }); // key stays server-side
  } catch (e) {
    res.status(502).json({ error: "fetch_failed", message: e.message });
  }
});
