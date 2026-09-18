// onchain.js — real BTC on-chain analytics from blockchain.info's public,
// keyless charts API (CORS-enabled via ?cors=true). This is genuine network
// data, not a price/volume proxy: how many people are actually using the
// network, how much value is moving, and how much mining power is committed.
//
// Coverage is Bitcoin only — blockchain.info's charts are BTC-specific, and no
// comparable multi-coin on-chain feed is available keyless from the browser.
// Broader coverage (ETH, exchange netflows, whale wallets, SOPR/MVRV) needs a
// paid provider (Glassnode/CryptoQuant) behind the backend.

const BASE = "https://api.blockchain.info/charts";
const METRICS = {
  addresses: "n-unique-addresses",              // active addresses — adoption/usage
  txVolumeUsd: "estimated-transaction-volume-usd", // economic throughput
  hashRate: "hash-rate",                        // miner conviction / network security
};

function ocFetch(chart, ms = 6500) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(`${BASE}/${chart}?timespan=180days&format=json&cors=true`, { signal: ctrl.signal })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .finally(() => clearTimeout(id));
}

// Is this symbol Bitcoin (in any of the app's notations)?
export function isBitcoin(symbol) {
  return /^BTC(USDT|USDC|BUSD)?$/i.test(symbol) || /^BTC-USD$/i.test(symbol) || symbol === "BTC";
}

export async function fetchBtcOnChain() {
  const [a, t, h] = await Promise.all([
    ocFetch(METRICS.addresses).catch(() => null),
    ocFetch(METRICS.txVolumeUsd).catch(() => null),
    ocFetch(METRICS.hashRate).catch(() => null),
  ]);
  const series = (j) => (j && Array.isArray(j.values) ? j.values.map((p) => ({ t: p.x * 1000, v: p.y })) : null);
  const out = { addresses: series(a), txVolumeUsd: series(t), hashRate: series(h) };
  if (!out.addresses && !out.txVolumeUsd && !out.hashRate) return null;
  return out;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
// % change over ~N daily points
function chgN(vals, n) {
  if (!vals || vals.length < n + 1) return null;
  const a = vals[vals.length - 1 - n].v, b = vals[vals.length - 1].v;
  return a ? ((b - a) / a) * 100 : null;
}

export function computeBtcOnChain(series) {
  if (!series) return { available: false, reason: "On-chain data unavailable right now." };
  const factors = [];
  const add = (key, label, weight, chg, scale, noteUp, noteDown, unitNote) => {
    if (chg == null) return;
    const vote = clamp(chg / scale, -1, 1);
    factors.push({ key, label, weight, vote, chg, note: `${label}: ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% (30d) — ${chg > 3 ? noteUp : chg < -3 ? noteDown : "roughly flat"}${unitNote || ""}` });
  };

  add("addresses", "Active addresses", 0.4, chgN(series.addresses, 30), 20,
    "more wallets transacting — adoption rising", "fewer active wallets — usage cooling");
  add("txVolume", "On-chain $ volume", 0.35, chgN(series.txVolumeUsd, 30), 30,
    "more value settling on-chain", "less value moving on-chain");
  add("hashRate", "Hash rate", 0.25, chgN(series.hashRate, 30), 15,
    "miners adding capacity — conviction & security up", "miners pulling back");

  if (!factors.length) return { available: false, reason: "On-chain data unavailable right now." };

  const wsum = factors.reduce((s, f) => s + f.weight, 0);
  const weighted = factors.reduce((s, f) => s + f.vote * f.weight, 0) / wsum;
  const score = clamp(Math.round(50 + weighted * 50), 0, 100);
  const label = score >= 62 ? "Network expanding" : score >= 45 ? "Network stable" : "Network contracting";
  const tone = score >= 62 ? "buy" : score >= 45 ? "hold" : "sell";
  const supporting = factors.filter((f) => f.vote > 0.1).sort((a, b) => b.vote - a.vote);
  const contradicting = factors.filter((f) => f.vote < -0.1).sort((a, b) => a.vote - b.vote);
  return { available: true, score, label, tone, factors, supporting, contradicting };
}
