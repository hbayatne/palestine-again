// data.js
// Fetches real OHLCV candles and fundamental metrics. Uses public, key-free,
// CORS-enabled endpoints so the app runs from a static file with no backend.
//
//   Prices/candles : Binance public REST (crypto)  — falls back to synthetic
//   Fundamentals   : CoinGecko public API (crypto)
//
// If the network is blocked or an endpoint fails, we degrade gracefully to a
// deterministic synthetic series so the engine is always demonstrable.

const BINANCE = "https://api.binance.com/api/v3";
const COINGECKO = "https://api.coingecko.com/api/v3";

// Map friendly interval -> Binance kline interval
export const INTERVALS = {
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
  "1w": "1w",
};

export async function fetchCandles(symbol, interval = "1d", limit = 400) {
  const url = `${BINANCE}/klines?symbol=${encodeURIComponent(
    symbol
  )}&interval=${INTERVALS[interval] || "1d"}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await safeText(res)}`);
  const raw = await res.json();
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("No candle data returned.");
  return raw.map((k) => ({
    time: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));
}

// Fundamentals for crypto via CoinGecko. `coingeckoId` e.g. "bitcoin".
export async function fetchFundamentals(coingeckoId) {
  if (!coingeckoId) return null;
  const url = `${COINGECKO}/coins/${encodeURIComponent(
    coingeckoId
  )}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const d = await res.json();
  const m = d.market_data || {};
  return {
    name: d.name,
    symbol: (d.symbol || "").toUpperCase(),
    marketCap: m.market_cap?.usd ?? null,
    marketCapRank: d.market_cap_rank ?? null,
    volume24h: m.total_volume?.usd ?? null,
    circulating: m.circulating_supply ?? null,
    maxSupply: m.max_supply ?? null,
    ath: m.ath?.usd ?? null,
    athChangePct: m.ath_change_percentage?.usd ?? null,
    change24h: m.price_change_percentage_24h ?? null,
    change7d: m.price_change_percentage_7d ?? null,
    change30d: m.price_change_percentage_30d ?? null,
    change1y: m.price_change_percentage_1y ?? null,
    sentimentUp: d.sentiment_votes_up_percentage ?? null,
  };
}

// Turn raw fundamentals into a -100..100 score with reasons.
export function scoreFundamentals(f) {
  if (!f) return null;
  const reasons = [];
  let score = 0;

  // Liquidity: volume/market-cap turnover. Healthy liquidity is mildly positive.
  if (f.volume24h && f.marketCap) {
    const turnover = f.volume24h / f.marketCap;
    if (turnover > 0.15) { score += 15; reasons.push(`High liquidity (24h turnover ${(turnover * 100).toFixed(1)}%)`); }
    else if (turnover > 0.03) { score += 8; reasons.push(`Healthy liquidity (${(turnover * 100).toFixed(1)}% turnover)`); }
    else { score -= 5; reasons.push(`Thin liquidity (${(turnover * 100).toFixed(1)}% turnover)`); }
  }

  // Market-cap rank as a quality/size proxy.
  if (f.marketCapRank) {
    if (f.marketCapRank <= 10) { score += 15; reasons.push(`Top-10 asset (rank #${f.marketCapRank})`); }
    else if (f.marketCapRank <= 50) { score += 8; reasons.push(`Large-cap (rank #${f.marketCapRank})`); }
    else if (f.marketCapRank > 200) { score -= 10; reasons.push(`Small-cap (rank #${f.marketCapRank}) — higher risk`); }
  }

  // Distance from all-time high: deep discounts = value opportunity but also weakness.
  if (f.athChangePct != null) {
    if (f.athChangePct > -15) { score -= 10; reasons.push(`Near ATH (${f.athChangePct.toFixed(0)}%) — limited upside, froth risk`); }
    else if (f.athChangePct < -75) { score += 12; reasons.push(`Deeply discounted (${f.athChangePct.toFixed(0)}% from ATH) — value zone`); }
    else { score += 4; reasons.push(`${f.athChangePct.toFixed(0)}% from ATH`); }
  }

  // Medium-term momentum (30d) as a fundamental-trend tilt.
  if (f.change30d != null) {
    if (f.change30d > 20) { score += 12; reasons.push(`Strong 30d momentum (+${f.change30d.toFixed(0)}%)`); }
    else if (f.change30d > 0) { score += 5; reasons.push(`Positive 30d (+${f.change30d.toFixed(0)}%)`); }
    else if (f.change30d < -20) { score -= 12; reasons.push(`Weak 30d (${f.change30d.toFixed(0)}%)`); }
    else { score -= 4; reasons.push(`Negative 30d (${f.change30d.toFixed(0)}%)`); }
  }

  // Supply pressure: uncapped or huge dilution ahead is a mild negative.
  if (f.maxSupply && f.circulating) {
    const pctOut = f.circulating / f.maxSupply;
    if (pctOut < 0.6) { score -= 6; reasons.push(`${(pctOut * 100).toFixed(0)}% of max supply circulating — dilution ahead`); }
    else { score += 4; reasons.push(`${(pctOut * 100).toFixed(0)}% of supply circulating — low dilution`); }
  } else if (!f.maxSupply) {
    reasons.push("No hard supply cap (inflationary)");
  }

  score = Math.max(-100, Math.min(100, score));
  return { score, reasons };
}

// Deterministic synthetic OHLCV so the app always works offline. Includes
// trend, cycles and volatility clustering so indicators produce varied output.
export function syntheticCandles(seedStr = "DEMO", n = 400) {
  let seed = 0;
  for (const ch of seedStr) seed = (seed * 31 + ch.charCodeAt(0)) % 2147483647;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const candles = [];
  let price = 100 + rand() * 200;
  let vol = 0.02;
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const trend = Math.sin(i / 40) * 0.004 + Math.sin(i / 13) * 0.002;
    vol = Math.max(0.008, vol * 0.94 + (rand() * 0.03) * 0.06); // vol clustering
    const shock = (rand() - 0.5) * vol * 4;
    const open = price;
    const close = Math.max(0.01, open * (1 + trend + shock));
    const high = Math.max(open, close) * (1 + rand() * vol);
    const low = Math.min(open, close) * (1 - rand() * vol);
    const volume = 1000 + rand() * 5000 * (1 + Math.abs(shock) * 20);
    candles.push({
      time: now - (n - i) * 86400000,
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }
  return candles;
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 140);
  } catch {
    return "";
  }
}
