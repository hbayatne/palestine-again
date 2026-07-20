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

// fetch with a hard timeout so a dead/blocked source fails fast instead of
// hanging the whole fallback chain.
async function tfetch(url, ms = 6000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

// Map friendly interval -> Binance kline interval
export const INTERVALS = {
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
  "1w": "1w",
};

// Tries several public exchanges in order so a regional block on one (e.g.
// Binance is unavailable in some countries) doesn't kill live data. Returns the
// first source that answers; throws only if every source fails.
export function looksLikeCrypto(symbol) {
  return /(USDT|USDC|BUSD)$/i.test(symbol);
}

export async function fetchCandles(symbol, interval = "1d", limit = 400) {
  // Crypto pairs go to native exchanges first (fast, no proxy needed); every
  // asset type also falls back to Yahoo, which covers stocks, ETFs, forex,
  // indices, commodities AND crypto.
  const sources = [];
  if (looksLikeCrypto(symbol)) {
    sources.push(
      { name: "Binance", fn: fromBinance },
      { name: "Coinbase", fn: fromCoinbase },
      { name: "Kraken", fn: fromKraken }
    );
  }
  sources.push({ name: "Yahoo", fn: fromYahoo });

  const errors = [];
  for (const s of sources) {
    try {
      const c = await s.fn(symbol, interval, limit);
      if (c && c.length) {
        c._source = s.name;
        return c;
      }
    } catch (e) {
      errors.push(`${s.name}: ${e.message}`);
    }
  }
  throw new Error(errors.join(" | ") || "No candle data from any source.");
}

async function fromBinance(symbol, interval, limit) {
  const url = `${BINANCE}/klines?symbol=${encodeURIComponent(
    symbol
  )}&interval=${INTERVALS[interval] || "1d"}&limit=${limit}`;
  const res = await tfetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("empty");
  return raw.map((k) => ({
    time: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));
}

// Coinbase Exchange public candles. product e.g. BTC-USD; granularity in seconds.
const CB_GRAN = { "15m": 900, "1h": 3600, "4h": 21600, "1d": 86400, "1w": 86400 };
async function fromCoinbase(symbol, interval, limit) {
  const product = toDashPair(symbol);
  const gran = CB_GRAN[interval] || 86400;
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${gran}`;
  const res = await tfetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  const raw = await res.json(); // [ time, low, high, open, close, volume ], newest first
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("empty");
  return raw
    .map((k) => ({
      time: k[0] * 1000,
      low: +k[1],
      high: +k[2],
      open: +k[3],
      close: +k[4],
      volume: +k[5],
    }))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

// Kraken public OHLC. pair e.g. XBTUSD; interval in minutes.
const KR_MIN = { "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080 };
async function fromKraken(symbol, interval, limit) {
  const pair = toKrakenPair(symbol);
  const mins = KR_MIN[interval] || 1440;
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${mins}`;
  const res = await tfetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json();
  if (data.error && data.error.length) throw new Error(data.error.join(","));
  const key = Object.keys(data.result).find((k) => k !== "last");
  const raw = data.result[key]; // [time, open, high, low, close, vwap, volume, count]
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("empty");
  return raw
    .map((k) => ({
      time: k[0] * 1000,
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[6],
    }))
    .slice(-limit);
}

// BTCUSDT -> BTC-USD  (Coinbase uses USD, not USDT)
function toDashPair(symbol) {
  const base = symbol.replace(/(USDT|BUSD|USDC|USD)$/i, "");
  return `${base}-USD`;
}
// BTCUSDT -> XBTUSD  (Kraken quirk: BTC is XBT)
function toKrakenPair(symbol) {
  let base = symbol.replace(/(USDT|BUSD|USDC|USD)$/i, "");
  if (base === "BTC") base = "XBT";
  return `${base}USD`;
}

// --- Yahoo Finance: the universal source (stocks, ETFs, forex, indices,
// commodities, crypto). Yahoo doesn't send CORS headers, so we route through
// public CORS proxies and try them in order for resilience. ---
const YF_PROXIES = [
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  (u) => u, // last resort: hit Yahoo directly (works if CORS ever allows it)
];
const YF_MAP = {
  "15m": { i: "15m", r: "1mo", agg: 1 },
  "1h": { i: "60m", r: "3mo", agg: 1 },
  "4h": { i: "60m", r: "1y", agg: 4 }, // Yahoo has no 4h; aggregate 4×1h
  "1d": { i: "1d", r: "2y", agg: 1 },
  "1w": { i: "1wk", r: "5y", agg: 1 },
};

// BTCUSDT -> BTC-USD for Yahoo; other symbols (AAPL, EURUSD=X, GC=F, ^GSPC) pass through.
function toYahooSymbol(sym) {
  if (looksLikeCrypto(sym)) return sym.replace(/(USDT|USDC|BUSD)$/i, "-USD");
  return sym;
}

async function fromYahoo(symbol, interval, limit) {
  const m = YF_MAP[interval] || YF_MAP["1d"];
  const ysym = toYahooSymbol(symbol);
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  let lastErr = "";
  for (const host of hosts) {
    const target = `https://${host}/v8/finance/chart/${encodeURIComponent(
      ysym
    )}?range=${m.r}&interval=${m.i}`;
    for (const wrap of YF_PROXIES) {
      try {
        const res = await tfetch(wrap(target), 5000);
        if (!res.ok) {
          lastErr = `${res.status}`;
          continue;
        }
        const json = await res.json();
        const parsed = parseYahoo(json, m.agg, limit);
        if (parsed && parsed.length) return parsed;
        lastErr = "no rows";
      } catch (e) {
        lastErr = e.message;
      }
    }
  }
  throw new Error(lastErr || "unreachable");
}

// Search any asset by name or ticker (stocks, ETFs, funds, crypto, forex…).
// Uses Yahoo's search endpoint through the same CORS proxies.
export async function searchSymbols(query) {
  const q = (query || "").trim();
  if (q.length < 1) return [];
  const target = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    q
  )}&quotesCount=10&newsCount=0`;
  for (const wrap of YF_PROXIES) {
    try {
      const res = await tfetch(wrap(target), 5000);
      if (!res.ok) continue;
      const json = await res.json();
      const quotes = (json && json.quotes) || [];
      const out = quotes
        .filter((x) => x.symbol && x.quoteType !== "OPTION")
        .map((x) => ({
          symbol: x.symbol,
          name: x.shortname || x.longname || x.symbol,
          type: (x.quoteType || "").toUpperCase(),
          exchange: x.exchDisp || x.exchange || "",
        }));
      if (out.length) return out;
    } catch {
      /* next proxy */
    }
  }
  return [];
}

// Latest price for a symbol (used by paper trading + watchlists). Reuses the
// full candle fetch and also returns the day-over-day change.
export async function fetchQuote(symbol) {
  const candles = await fetchCandles(symbol, "1d", 60);
  if (!candles || !candles.length) throw new Error("no price");
  const price = candles[candles.length - 1].close;
  const prev = candles.length > 1 ? candles[candles.length - 2].close : price;
  const changePct = prev ? ((price - prev) / prev) * 100 : 0;
  return { price, prevClose: prev, changePct, source: candles._source };
}

// ===== Fundamentals (for the Value & Quality scorecard) =====
// Reliable fundamentals aren't available keyless anymore, so we use Financial
// Modeling Prep (free API key) when present, and best-effort keyless Yahoo
// quoteSummary via proxy otherwise. Returns a normalized object or null.
const FMP = "https://financialmodelingprep.com/api/v3";
const FMP_KEY_STORE = "signaldesk_fmp_key";

export function getFmpKey() {
  try {
    return localStorage.getItem(FMP_KEY_STORE) || "";
  } catch {
    return "";
  }
}
export function setFmpKey(k) {
  try {
    if (k && k.trim()) localStorage.setItem(FMP_KEY_STORE, k.trim());
    else localStorage.removeItem(FMP_KEY_STORE);
  } catch {
    /* ignore */
  }
}

async function fmpGet(path, key) {
  const url = `${FMP}${path}${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(key)}`;
  const res = await tfetch(url, 8000);
  if (!res.ok) throw new Error("FMP " + res.status);
  const j = await res.json();
  if (j && j["Error Message"]) throw new Error(j["Error Message"]);
  return j;
}

export async function fetchFundamentalsFull(symbol) {
  const key = getFmpKey();
  if (key) {
    try {
      return await fromFMP(symbol, key);
    } catch {
      /* fall back to keyless Yahoo */
    }
  }
  try {
    return await fromYahooFundamentals(symbol);
  } catch {
    return null;
  }
}

async function fromFMP(sym, key) {
  const [prof, ratios, inc] = await Promise.all([
    fmpGet(`/profile/${sym}`, key),
    fmpGet(`/ratios-ttm/${sym}`, key),
    fmpGet(`/income-statement/${sym}?period=annual&limit=2`, key),
  ]);
  const p = Array.isArray(prof) ? prof[0] : null;
  const r = Array.isArray(ratios) ? ratios[0] : null;
  const i0 = Array.isArray(inc) ? inc[0] : null;
  const i1 = Array.isArray(inc) ? inc[1] : null;
  if (!p && !r) throw new Error("no FMP data");
  const revenue = i0 && i0.revenue != null ? +i0.revenue : null;
  const revPrev = i1 && i1.revenue != null ? +i1.revenue : null;
  const revenueGrowthPct = revenue && revPrev ? ((revenue - revPrev) / Math.abs(revPrev)) * 100 : null;
  const netMarginPct = r && r.netProfitMarginTTM != null ? r.netProfitMarginTTM * 100 : revenue && i0 ? (i0.netIncome / revenue) * 100 : null;
  const grossMarginPct = r && r.grossProfitMarginTTM != null ? r.grossProfitMarginTTM * 100 : revenue && i0 ? (i0.grossProfit / revenue) * 100 : null;
  return {
    symbol: sym,
    name: p ? p.companyName : sym,
    sector: p ? p.sector : null,
    industry: p ? p.industry : null,
    price: p && p.price != null ? +p.price : null,
    marketCap: p && p.mktCap != null ? +p.mktCap : null,
    beta: p && p.beta != null ? +p.beta : null,
    eps: i0 && i0.eps != null ? +i0.eps : null,
    pe: r && r.priceEarningsRatioTTM != null ? +r.priceEarningsRatioTTM : null,
    grossMarginPct,
    netMarginPct,
    revenue,
    revenueGrowthPct,
    debtToEquity: r && r.debtEquityRatioTTM != null ? +r.debtEquityRatioTTM : null,
    currentRatio: r && r.currentRatioTTM != null ? +r.currentRatioTTM : null,
    fcfPositive: netMarginPct != null ? netMarginPct > 0 : null,
    source: "Financial Modeling Prep",
  };
}

async function fromYahooFundamentals(sym) {
  const target = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    sym
  )}?modules=assetProfile,financialData,defaultKeyStatistics,summaryDetail,price`;
  let json;
  for (const wrap of YF_PROXIES) {
    try {
      const res = await tfetch(wrap(target), 6000);
      if (!res.ok) continue;
      json = await res.json();
      if (json && json.quoteSummary) break;
    } catch {
      /* next proxy */
    }
  }
  const r = json && json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
  if (!r) throw new Error("no Yahoo fundamentals");
  const fd = r.financialData || {};
  const ks = r.defaultKeyStatistics || {};
  const sd = r.summaryDetail || {};
  const pr = r.price || {};
  const ap = r.assetProfile || {};
  const num = (o) => (o && o.raw != null ? o.raw : null);
  const d2e = num(fd.debtToEquity); // Yahoo reports as a percentage
  return {
    symbol: sym,
    name: pr.longName || pr.shortName || sym,
    sector: ap.sector || null,
    industry: ap.industry || null,
    price: num(pr.regularMarketPrice),
    marketCap: num(pr.marketCap) || num(sd.marketCap),
    beta: num(ks.beta),
    eps: num(ks.trailingEps),
    pe: num(sd.trailingPE),
    grossMarginPct: num(fd.grossMargins) != null ? num(fd.grossMargins) * 100 : null,
    netMarginPct: num(fd.profitMargins) != null ? num(fd.profitMargins) * 100 : null,
    revenue: num(fd.totalRevenue),
    revenueGrowthPct: num(fd.revenueGrowth) != null ? num(fd.revenueGrowth) * 100 : null,
    debtToEquity: d2e != null ? d2e / 100 : null,
    currentRatio: num(fd.currentRatio),
    fcfPositive: num(fd.freeCashflow) != null ? num(fd.freeCashflow) > 0 : null,
    source: "Yahoo Finance",
  };
}

// Lightweight peer metrics for competitive ranking (2 calls per peer).
export async function fetchPeerMetrics(sym) {
  const key = getFmpKey();
  if (key) {
    try {
      const [prof, ratios] = await Promise.all([fmpGet(`/profile/${sym}`, key), fmpGet(`/ratios-ttm/${sym}`, key)]);
      const p = Array.isArray(prof) ? prof[0] : null;
      const r = Array.isArray(ratios) ? ratios[0] : null;
      return {
        symbol: sym,
        marketCap: p && p.mktCap != null ? +p.mktCap : null,
        netMarginPct: r && r.netProfitMarginTTM != null ? r.netProfitMarginTTM * 100 : null,
        grossMarginPct: r && r.grossProfitMarginTTM != null ? r.grossProfitMarginTTM * 100 : null,
        revenue: null,
      };
    } catch {
      return null;
    }
  }
  try {
    const f = await fromYahooFundamentals(sym);
    return { symbol: sym, marketCap: f.marketCap, netMarginPct: f.netMarginPct, grossMarginPct: f.grossMarginPct, revenue: f.revenue };
  } catch {
    return null;
  }
}

// Run an async fn over items with bounded concurrency (keeps proxy load sane).
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        results[idx] = { error: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parseYahoo(json, agg, limit) {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.timestamp) {
    const desc = json && json.chart && json.chart.error && json.chart.error.description;
    throw new Error(desc || "invalid symbol");
  }
  const q = r.indicators.quote[0];
  let candles = r.timestamp
    .map((t, i) => ({
      time: t * 1000,
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      volume: q.volume[i] || 0,
    }))
    .filter((c) => c.open != null && c.close != null && c.high != null && c.low != null);
  if (agg > 1) candles = aggregateCandles(candles, agg);
  return candles.slice(-limit);
}

function aggregateCandles(c, n) {
  const out = [];
  for (let i = 0; i < c.length; i += n) {
    const g = c.slice(i, i + n);
    if (!g.length) continue;
    out.push({
      time: g[0].time,
      open: g[0].open,
      high: Math.max(...g.map((x) => x.high)),
      low: Math.min(...g.map((x) => x.low)),
      close: g[g.length - 1].close,
      volume: g.reduce((s, x) => s + x.volume, 0),
    });
  }
  return out;
}

// Fundamentals for crypto via CoinGecko. `coingeckoId` e.g. "bitcoin".
export async function fetchFundamentals(coingeckoId) {
  if (!coingeckoId) return null;
  const url = `${COINGECKO}/coins/${encodeURIComponent(
    coingeckoId
  )}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`;
  const res = await tfetch(url);
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
