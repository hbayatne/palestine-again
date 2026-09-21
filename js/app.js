// app.js — UI controller: auth gate -> tier gating -> data -> signal -> render.
import { analyze, combine, VOTER_KEYS, recommend } from "./signals.js";
import {
  fetchCandles,
  fetchFundamentals,
  scoreFundamentals,
  syntheticCandles,
  looksLikeCrypto,
  searchSymbols,
  fetchQuote,
  mapLimit,
  fetchFundamentalsFull,
  fetchPeerMetrics,
  fetchProfiles,
  fetchRatiosTTM,
  getFmpKey,
  setFmpKey,
  testFmpKey,
} from "./data.js";
import { buildScorecard, scoreCompetition, INDUSTRY_PEERS, buildRankerRow } from "./valuation.js";
import { TIERS, TIER_ORDER } from "./tiers.js";
import * as auth from "./auth.js";
import { fetchNews } from "./news.js";
import { WATCHLISTS } from "./watchlists.js";
import * as portfolio from "./portfolio.js";
import {
  fetchFearGreed,
  fgRead,
  fgTone,
  fetchCoinbasePremium,
  accumulationScore,
  accumulationOpportunity,
} from "./sentiment.js";
import { computeEdge, edgeAdjustedConfidence, computeRegime } from "./edge.js";
import { detectDivergences, recentPivots, compressionState } from "./divergence.js";
import { computeMarketRegime, REGIME_SYMBOLS } from "./regime.js";
import { isBitcoin, fetchBtcOnChain, computeBtcOnChain } from "./onchain.js";

// Presets across asset classes. `cg` (CoinGecko id) enables crypto fundamentals.
const PRESET_GROUPS = [
  {
    group: "Crypto",
    items: [
      { symbol: "BTCUSDT", cg: "bitcoin", label: "Bitcoin" },
      { symbol: "ETHUSDT", cg: "ethereum", label: "Ethereum" },
      { symbol: "SOLUSDT", cg: "solana", label: "Solana" },
      { symbol: "BNBUSDT", cg: "binancecoin", label: "BNB" },
      { symbol: "XRPUSDT", cg: "ripple", label: "XRP" },
      { symbol: "ADAUSDT", cg: "cardano", label: "Cardano" },
      { symbol: "AVAXUSDT", cg: "avalanche-2", label: "Avalanche" },
      { symbol: "DOGEUSDT", cg: "dogecoin", label: "Dogecoin" },
      { symbol: "LINKUSDT", cg: "chainlink", label: "Chainlink" },
      { symbol: "MATICUSDT", cg: "matic-network", label: "Polygon" },
      { symbol: "ZECUSDT", cg: "zcash", label: "Zcash" },
    ],
  },
  {
    group: "Mega-cap Stocks",
    items: [
      { symbol: "AAPL", label: "Apple" },
      { symbol: "MSFT", label: "Microsoft" },
      { symbol: "NVDA", label: "Nvidia" },
      { symbol: "AMZN", label: "Amazon" },
      { symbol: "GOOGL", label: "Alphabet" },
      { symbol: "META", label: "Meta" },
      { symbol: "TSLA", label: "Tesla" },
      { symbol: "AVGO", label: "Broadcom" },
      { symbol: "TSM", label: "Taiwan Semi (TSMC)" },
      { symbol: "JPM", label: "JPMorgan" },
      { symbol: "BRK-B", label: "Berkshire" },
    ],
  },
  {
    group: "Popular ETFs",
    items: [
      { symbol: "SPY", label: "S&P 500 (SPY)" },
      { symbol: "VOO", label: "Vanguard S&P 500" },
      { symbol: "QQQ", label: "Nasdaq 100" },
      { symbol: "VTI", label: "Total US Market" },
      { symbol: "SCHD", label: "Schwab Dividend" },
      { symbol: "JEPI", label: "JPM Premium Income" },
      { symbol: "SMH", label: "Semiconductors" },
      { symbol: "IWM", label: "Russell 2000" },
    ],
  },
  {
    group: "Forex",
    items: [
      { symbol: "EURUSD=X", label: "EUR / USD" },
      { symbol: "GBPUSD=X", label: "GBP / USD" },
      { symbol: "USDJPY=X", label: "USD / JPY" },
      { symbol: "AUDUSD=X", label: "AUD / USD" },
      { symbol: "USDCAD=X", label: "USD / CAD" },
    ],
  },
  {
    group: "Commodities & Indices",
    items: [
      { symbol: "GC=F", label: "Gold" },
      { symbol: "SI=F", label: "Silver" },
      { symbol: "CL=F", label: "Crude Oil" },
      { symbol: "NG=F", label: "Natural Gas" },
      { symbol: "^GSPC", label: "S&P 500 Index" },
      { symbol: "^IXIC", label: "Nasdaq Composite" },
      { symbol: "^DJI", label: "Dow Jones" },
      { symbol: "^VIX", label: "Volatility (VIX)" },
    ],
  },
];

// Candidate "ideas to add" for the Portfolio Doctor — quality, liquid names.
const ADD_CANDIDATES = [
  "VOO", "VTI", "SCHD", "QQQ", "NVDA", "MSFT", "AAPL", "AVGO", "JEPI", "SMH", "GC=F", "BTCUSDT",
];

// Default universe for the Stock Ranker — a broad set of liquid US large/mid caps.
const RANKER_DEFAULT = [
  // Tech / semis / software
  "AAPL","MSFT","NVDA","GOOGL","META","AMZN","AVGO","ORCL","ADBE","CRM","AMD","QCOM","TXN","INTC","MU",
  "AMAT","LRCX","KLAC","NOW","INTU","IBM","CSCO","ACN","SHOP","UBER","PLTR","SNOW","PANW","CRWD","DDOG",
  "NET","ANET","MRVL","SMCI","DELL","HPQ","ADI","NXPI","ASML","TSM",
  // Communication / media
  "NFLX","DIS","CMCSA","T","VZ","TMUS","WBD","SPOT","PINS","SNAP","RBLX","EA","TTWO",
  // Consumer discretionary / retail
  "TSLA","HD","LOW","NKE","MCD","SBUX","BKNG","CMG","MAR","TGT","LULU","ORLY","AZO","F","GM","RIVN",
  // Consumer staples
  "WMT","COST","PG","KO","PEP","MDLZ","CL","MO","PM","KMB","GIS","KHC","MNST","KDP",
  // Healthcare
  "LLY","UNH","JNJ","ABBV","MRK","PFE","TMO","ABT","DHR","AMGN","ISRG","GILD","BMY","VRTX","REGN","CVS","MDT","ZTS",
  // Financials
  "BRK-B","JPM","V","MA","BAC","WFC","GS","MS","C","AXP","SCHW","BLK","SPGI","PYPL","COIN","HOOD","PGR","CB",
  // Industrials / energy / materials
  "CAT","DE","BA","GE","HON","UPS","RTX","LMT","UNP","MMM","XOM","CVX","COP","SLB","EOG","LIN","FCX","NEM","NUE",
  // Utilities / real estate
  "NEE","DUK","SO","O","PLD","AMT","EQIX",
];
const ALL_PRESETS = PRESET_GROUPS.flatMap((g) => g.items);

const TF_LABELS = { "15m": "15 min", "1h": "1 hour", "4h": "4 hour", "1d": "Daily", "1w": "Weekly", "1M": "Monthly" };
const EDGE_HORIZON = { "15m": 16, "1h": 12, "4h": 10, "1d": 10, "1w": 4, "1M": 3 };

const $ = (id) => document.getElementById(id);
const state = { candles: [], result: null, fundamentals: null };

// DEV MODE: while building, everyone gets full access and login is optional.
// The tier machinery stays intact — flip this to false to enforce real tiers.
const DEV_FULL_ACCESS = true;

function currentTier() {
  // Dev mode unlocks everything for everyone — signed in or not — so logging in
  // never locks features. The "preview tier" pick still lets you test gating.
  if (DEV_FULL_ACCESS) return TIERS[auth.getViewAs() || "pro"] || TIERS.pro;
  const u = auth.getUser();
  if (u) return TIERS[auth.effectiveTierId()] || TIERS.free;
  return TIERS.free;
}

function fmt(v, opts = {}) {
  if (v == null || Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  if (opts.pct) return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  if (opts.compact) {
    if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
    return `$${v.toFixed(2)}`;
  }
  if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return v.toFixed(2);
  return v.toPrecision(4);
}

// ---------------- Analysis run ----------------
async function run() {
  const tier = currentTier();
  const symbol = $("symbol").value.trim().toUpperCase();
  if (!symbol) return;
  let interval = $("interval").value;
  if (!tier.timeframes.includes(interval)) interval = tier.timeframes[tier.timeframes.length - 1];

  setStatus("Fetching market data…", "loading");
  $("analyzeBtn").disabled = true;

  let candles;
  let source;
  try {
    candles = await fetchCandles(symbol, interval, 400);
    source = `${candles._source || "Exchange"} (live)`;
  } catch (err) {
    candles = syntheticCandles(symbol + interval, 400);
    source = "Synthetic demo data (live fetch failed)";
    console.warn("Live fetch failed, using synthetic:", err);
  }
  state.candles = candles;
  resetChartView(candles.length);

  // Fundamentals — Pro only, crypto only (has a CoinGecko id).
  let fundScore = null;
  state.fundamentals = null;
  const preset = ALL_PRESETS.find((p) => p.symbol === symbol);
  if (tier.fundamentals && preset && preset.cg) {
    try {
      const f = await fetchFundamentals(preset.cg);
      state.fundamentals = f;
      fundScore = scoreFundamentals(f);
    } catch (err) {
      console.warn("Fundamentals fetch failed:", err);
    }
  }

  const result = analyze(candles, { voters: tier.voters === "all" ? undefined : tier.voters });
  if (fundScore) result.blendedScore = combine(result.score, fundScore.score, 0.7);
  result.fundScore = fundScore;
  state.result = result;

  render(result, symbol, tier);
  setStatus(
    `${symbol} · ${TF_LABELS[interval] || interval} · ${candles.length} candles · ${source}`,
    source.includes("Synthetic") ? "warn" : "ok"
  );
  $("analyzeBtn").disabled = false;

  // Business quality & value (stocks only, Pro) — loads async, non-blocking.
  loadValue(symbol, tier);

  // Market sentiment & accumulation (crypto) — loads async, non-blocking.
  loadSentiment(symbol, tier, result);

  // On-chain analytics (Bitcoin) — loads async, non-blocking.
  loadOnChain(symbol, tier);

  // Edge analytics (historical backtest of this signal) — deferred so it never
  // blocks the first paint.
  loadEdge(symbol, tier, interval, result);
}

// ---------------- Edge analytics ----------------
let edgeReqId = 0;
function loadEdge(symbol, tier, interval, result) {
  const card = $("edgeCard");
  if (!card) return;
  if (!tier.confidence) {           // edge analytics are a Lite+ perk
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  // Market regime is cheap — render it immediately.
  const regime = computeRegime(result);
  renderRegime(regime);

  $("edgeContent").innerHTML = `<p class="status loading">Back-testing this signal on ${state.candles.length} bars of history…</p>`;
  const myReq = ++edgeReqId;
  const candles = state.candles;
  const horizon = EDGE_HORIZON[interval] || 10;
  const voters = tier.voters === "all" ? undefined : tier.voters;

  // Defer the CPU-heavy backtest to the next tick so the UI stays responsive.
  setTimeout(() => {
    if (myReq !== edgeReqId) return;
    let edge;
    try {
      edge = computeEdge(candles, (slice) => analyze(slice, { voters }), { horizon });
    } catch (e) {
      edge = { available: false, reason: "Edge calculation failed." };
    }
    if (myReq !== edgeReqId) return;
    renderEdge(edge, result, interval);
  }, 30);
}

function renderRegime(regime) {
  const el = $("edgeRegime");
  if (!el) return;
  const bits = [`<span class="er-pill ${regime.tone}">${esc(regime.trend)}</span>`];
  if (regime.vol) bits.push(`<span class="er-pill">Volatility: ${regime.vol}${regime.atrPct != null ? ` (ATR ${regime.atrPct.toFixed(1)}%)` : ""}</span>`);
  if (regime.adx != null) bits.push(`<span class="er-pill">ADX ${regime.adx.toFixed(0)}</span>`);
  el.innerHTML = bits.join("");
}

function renderEdge(edge, result, interval) {
  const c = $("edgeContent");
  const tf = TF_LABELS[interval] || interval;
  if (!edge || !edge.available) {
    c.innerHTML = `<p class="val-empty-note">${esc((edge && edge.reason) || "Edge unavailable for this asset/timeframe.")}</p>`;
    return;
  }
  if (!edge.directional) {
    c.innerHTML = `<p class="edge-note">${esc(edge.note)}</p>
      <p class="val-source">Measured over ${edge.n} past bars · ${esc(tf)} · ${edge.horizon}-bar horizon. In-sample estimate — not a guarantee.</p>`;
    return;
  }
  const adjConf = edgeAdjustedConfidence(result.confidence, edge);
  const dirWord = edge.curDir > 0 ? "bullish" : "bearish";
  const pct = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
  const metrics = [
    chip("Hit rate", (edge.hitRate * 100).toFixed(0) + "%", edge.hitRate >= 0.55 ? "buy" : edge.hitRate < 0.45 ? "sell" : "warn"),
    chip("Expectancy / signal", pct(edge.expectancy), edge.expectancy > 0 ? "buy" : "sell"),
    chip("Avg favorable", pct(edge.avgFav), "buy"),
    chip("Avg adverse", pct(edge.avgUnfav), "sell"),
    chip("Reward : risk", edge.payoff != null ? edge.payoff.toFixed(2) + " : 1" : "—"),
    chip("Sample size", edge.n + " signals"),
  ].join("");
  c.innerHTML = `
    <div class="edge-top">
      <div class="edge-badge ${edge.tone}">${esc(edge.label)}</div>
      <div class="edge-headline">Over the last ${state.candles.length} ${esc(tf.toLowerCase())} bars, when the signal was
        <b>${dirWord}</b> like now, price moved its way <b>${(edge.hitRate * 100).toFixed(0)}%</b> of the time
        ${edge.horizon} bars later — average <b>${pct(edge.expectancy)}</b> per signal.</div>
    </div>
    <div class="metrics">${metrics}</div>
    <div class="edge-conf">Model confidence <b>${result.confidence}%</b> → edge-adjusted <b class="${adjConf >= result.confidence ? "buy" : "sell"}">${adjConf}%</b></div>
    <p class="val-source">In-sample backtest on this asset's recent ${esc(tf.toLowerCase())} history (${edge.n} matching signals, ${edge.horizon}-bar horizon). Past behaviour is not a promise — signals still fail. Not financial advice.</p>`;
}

// ---------------- Fear & Greed + Accumulation Radar ----------------
let sentimentReqId = 0;
async function loadSentiment(symbol, tier, result) {
  const fgCard = $("fgCard");
  const accumCard = $("accumCard");
  const callout = $("accumOpportunity");
  const isCrypto = assetType(symbol) === "Crypto";

  // These are crypto-only tools; hide them cleanly for everything else.
  if (!isCrypto || !tier.sentiment) {
    fgCard.classList.add("hidden");
    accumCard.classList.add("hidden");
    callout.classList.add("hidden");
    return;
  }
  const myReq = ++sentimentReqId;

  // --- Accumulation radar (candles are already loaded; premium is async) ---
  accumCard.classList.remove("hidden");
  $("accumContent").innerHTML = `<p class="status loading">Reading order flow…</p>`;
  const premium = looksLikeCrypto(symbol) ? await fetchCoinbasePremium(symbol) : null;
  if (myReq !== sentimentReqId) return;
  const accum = accumulationScore(state.candles, premium ? premium.premiumPct : null);
  accum.symbol = symbol.replace(/(USDT|USDC|BUSD)$/i, "").replace(/-USD$/i, "");
  renderAccum(accum, premium);

  // Opportunity / caution banner tied to the technical signal.
  const opp = accumulationOpportunity(accum, result.action);
  if (opp) {
    callout.className = "accum-callout " + (opp.kind === "buy-dip" ? "opp-buy" : "opp-warn");
    callout.innerHTML = `<span class="ac-icon">${opp.kind === "buy-dip" ? "🐋" : "⚠️"}</span>
      <span><b>${esc(opp.title)}</b> — ${esc(opp.body)}</span>`;
    callout.classList.remove("hidden");
  } else {
    callout.classList.add("hidden");
  }

  // --- Fear & Greed (market-wide) ---
  fgCard.classList.remove("hidden");
  $("fgContent").innerHTML = `<p class="status loading">Loading market sentiment…</p>`;
  try {
    const fg = await fetchFearGreed(31);
    if (myReq !== sentimentReqId) return;
    renderFearGreed(fg);
  } catch (err) {
    if (myReq !== sentimentReqId) return;
    $("fgContent").innerHTML = `<p class="val-empty-note">Sentiment index unavailable right now (${esc(err.message)}).</p>`;
  }
}

// ---------------- On-chain analytics (Bitcoin) ----------------
const ONCHAIN_CACHE = "signaldesk_onchain_v1";
const ONCHAIN_TTL = 60 * 60 * 1000; // 1h — on-chain metrics are daily
let onchainReqId = 0;
async function loadOnChain(symbol, tier) {
  const card = $("onchainCard");
  if (!card) return;
  if (!tier.sentiment || !isBitcoin(symbol)) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  const myReq = ++onchainReqId;

  // fresh cache?
  try {
    const cached = JSON.parse(localStorage.getItem(ONCHAIN_CACHE));
    if (cached && cached.oc && Date.now() - cached.ts < ONCHAIN_TTL) { renderOnChain(cached.oc); return; }
  } catch { /* ignore */ }

  $("onchainContent").innerHTML = `<p class="status loading">Reading the Bitcoin network…</p>`;
  const series = await fetchBtcOnChain();
  if (myReq !== onchainReqId) return;
  const oc = computeBtcOnChain(series);
  if (!oc.available) {
    $("onchainContent").innerHTML = `<p class="val-empty-note">${esc(oc.reason || "On-chain data unavailable.")}</p>`;
    return;
  }
  try { localStorage.setItem(ONCHAIN_CACHE, JSON.stringify({ ts: Date.now(), oc })); } catch { /* ignore */ }
  renderOnChain(oc);
}

function renderOnChain(oc) {
  const chips = oc.factors
    .map((f) => chip(f.label, (f.chg >= 0 ? "+" : "") + f.chg.toFixed(1) + "%", f.vote > 0.1 ? "buy" : f.vote < -0.1 ? "sell" : ""))
    .join("");
  const reasons = [...oc.supporting, ...oc.contradicting].map((f) => `<li>${esc(f.note)}</li>`).join("");
  $("onchainContent").innerHTML = `
    <div class="accum-top">
      <div class="accum-dial ${oc.tone}">${oc.score}<span>/100</span></div>
      <div class="accum-meta">
        <div class="accum-verdict ${oc.tone}">${esc(oc.label)}</div>
        <div class="accum-sub">Real Bitcoin network activity over the last 30 days — usage, value settled, and mining power.</div>
      </div>
    </div>
    <div class="metrics">${chips}</div>
    ${reasons ? `<ul class="fund-reasons">${reasons}</ul>` : ""}
    <p class="val-source">Source: blockchain.info (public, keyless). On-chain activity is a fundamental backdrop — rising usage/security is constructive, but it is not a price signal. BTC only. Not financial advice.</p>`;
}

function renderAccum(accum, premium) {
  if (!accum.available) {
    $("accumContent").innerHTML = `<p class="val-empty-note">${esc(accum.reason || "Accumulation read unavailable for this source.")}</p>`;
    return;
  }
  const tone = accum.score >= 70 ? "buy" : accum.score >= 58 ? "buy" : accum.score >= 42 ? "hold" : "sell";
  const premRow =
    premium && premium.premiumPct != null
      ? chip("Coinbase premium", (premium.premiumPct >= 0 ? "+" : "") + premium.premiumPct.toFixed(2) + "%", premium.premiumPct > 0.02 ? "buy" : premium.premiumPct < -0.05 ? "sell" : "")
      : chip("Coinbase premium", "n/a");
  const metrics = [
    chip("Dip from high", "−" + accum.dipPct.toFixed(1) + "%", accum.inDip ? "warn" : ""),
    chip("Money flow (CMF)", accum.cmf != null ? accum.cmf.toFixed(2) : "n/a", accum.cmf > 0 ? "buy" : accum.cmf < 0 ? "sell" : ""),
    premRow,
    chip("A/D divergence", accum.bullishDivergence ? "Bullish" : "—", accum.bullishDivergence ? "buy" : ""),
  ].join("");
  const reasons = accum.reasons.length
    ? `<ul class="fund-reasons">${accum.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
    : "";
  $("accumContent").innerHTML = `
    <div class="accum-top">
      <div class="accum-dial ${tone}">${accum.score}<span>/100</span></div>
      <div class="accum-meta">
        <div class="accum-verdict ${tone}">${esc(accum.verdict)}</div>
        <div class="accum-sub">How much this looks like smart-money buying, from price &amp; volume behaviour.</div>
      </div>
    </div>
    <div class="accum-gauge"><span class="fill ${tone}" style="width:${accum.score}%"></span></div>
    <div class="metrics">${metrics}</div>
    ${reasons}
    <p class="val-source">A transparent proxy from Coinbase premium + Accumulation/Distribution + volume absorption — <b>not</b> literal on-chain wallet data. Educational, not financial advice.</p>`;
}

function renderFearGreed(fg) {
  const tone = fgTone(fg.value);
  const delta = fg.prevValue != null ? fg.value - fg.prevValue : null;
  const deltaStr = delta == null ? "" : `<span class="fg-delta ${delta >= 0 ? "buy" : "sell"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)} vs yesterday</span>`;
  $("fgContent").innerHTML = `
    <div class="fg-top">
      <div class="fg-value ${tone}">${fg.value}<span>/100</span></div>
      <div class="fg-meta">
        <div class="fg-label ${tone}">${esc(fg.label)}</div>
        ${deltaStr}
      </div>
    </div>
    <div class="fg-gauge"><span class="fill" style="width:${fg.value}%"></span><i class="fg-marker" style="left:${fg.value}%"></i></div>
    <div class="fg-scale"><span>Extreme Fear</span><span>Neutral</span><span>Extreme Greed</span></div>
    <canvas id="fgSpark" class="fg-spark"></canvas>
    <p class="fg-read">${esc(fgRead(fg.value))}</p>
    <p class="val-source">Source: Alternative.me Crypto Fear &amp; Greed Index (market-wide, updates daily).</p>`;
  drawFgSpark(fg.history);
}

// Tiny 30-day sparkline for the Fear & Greed history.
function drawFgSpark(history) {
  const cv = $("fgSpark");
  if (!cv || !history || history.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300;
  const h = 46;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const vals = history.map((d) => d.value);
  const min = 0, max = 100;
  const x = (i) => (i / (vals.length - 1)) * (w - 4) + 2;
  const y = (v) => h - 4 - ((v - min) / (max - min)) * (h - 8);
  // fear/greed band tint
  ctx.strokeStyle = "rgba(148,163,184,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y(50)); ctx.lineTo(w, y(50)); ctx.stroke();
  ctx.beginPath();
  vals.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = "#f5a623";
  ctx.lineWidth = 2;
  ctx.stroke();
  // last point dot
  const li = vals.length - 1;
  ctx.beginPath();
  ctx.arc(x(li), y(vals[li]), 3, 0, Math.PI * 2);
  ctx.fillStyle = "#f5a623";
  ctx.fill();
}

// ---------------- Value & Quality scorecard ----------------
let valueReqId = 0;
async function loadValue(symbol, tier) {
  const card = $("valueCard");
  if (!card) return;
  if (!tier.fundamentals || assetType(symbol) !== "Stock") {
    card.classList.add("hidden");
    return;
  }
  const myReq = ++valueReqId;
  card.classList.remove("hidden");
  $("valueContent").innerHTML = `<p class="status loading">Loading business fundamentals for ${esc(symbol)}…</p>`;

  const f = await fetchFundamentalsFull(symbol);
  if (myReq !== valueReqId) return; // superseded by a newer analyze
  if (!f || f.__error || (f.netMarginPct == null && f.grossMarginPct == null && f.pe == null)) {
    $("valueContent").innerHTML = noFundamentalsMsg(f && f.__error);
    return;
  }

  // competitive ranking against curated peers
  let competition = null;
  const peerSyms = (INDUSTRY_PEERS[symbol] || []).slice(0, 3);
  if (peerSyms.length) {
    const peers = (await mapLimit(peerSyms, 3, (s) => fetchPeerMetrics(s))).filter((x) => x && !x.error);
    if (myReq !== valueReqId) return;
    if (peers.length) {
      competition = scoreCompetition(
        { symbol, marketCap: f.marketCap, netMarginPct: f.netMarginPct, grossMarginPct: f.grossMarginPct, revenue: f.revenue },
        peers
      );
    }
  }

  const card2 = buildScorecard(f, competition);
  renderValue(f, card2);
}

function renderValue(f, card) {
  const gradeTone = card.overall >= 66 ? "buy" : card.overall >= 50 ? "" : "sell";
  const bars = card.parts
    .map((p) => {
      if (p.score == null)
        return `<div class="val-row"><div class="val-head"><span>${esc(p.label)}</span><span class="val-na">n/a</span></div>
          <div class="val-hint">${esc(p.hint)}</div></div>`;
      const tone = p.score >= 66 ? "buy" : p.score >= 45 ? "hold" : "sell";
      return `<div class="val-row">
        <div class="val-head"><span>${esc(p.label)}</span><span class="val-score ${tone}">${p.score}</span></div>
        <div class="val-bar"><span class="val-fill ${tone}" style="width:${p.score}%"></span></div>
        <div class="val-hint">${esc(p.hint)}</div>
      </div>`;
    })
    .join("");
  const money =
    card.makesMoney == null
      ? ""
      : card.makesMoney
      ? `<span class="val-badge buy">Profitable</span>`
      : `<span class="val-badge sell">Losing money</span>`;
  $("valueContent").innerHTML = `
    <div class="val-top">
      <div class="val-grade ${gradeTone}">${card.rating}<span>${card.overall}/100</span></div>
      <div class="val-meta">
        <div class="val-name">${esc(f.name || f.symbol)} ${money}</div>
        <div class="val-sub">${esc([f.sector, f.industry].filter(Boolean).join(" · ") || "—")}</div>
        <div class="val-fair">${esc(card.valuation.note || "")}</div>
      </div>
    </div>
    ${bars}
    <p class="val-source">Fundamentals via ${esc(f.source || "provider")}. Educational scoring — not financial advice; verify figures before investing.</p>`;
}

function noFundamentalsMsg(reason) {
  const hasKey = !!getFmpKey();
  return `<div class="val-empty">
    <p><b>Fundamentals unavailable for this symbol.</b> ${
      hasKey
        ? "The data provider didn't return figures. This can be a non-US/ETF ticker, a rate limit, or a key that only works on one API version."
        : "Quality & value scoring needs a fundamentals data source."
    }</p>
    ${reason ? `<p class="val-reason">Provider said: <code>${esc(reason)}</code></p>` : ""}
    ${
      hasKey
        ? `<p>Open <b>☰ Account → Fundamentals data</b> and hit <b>Test key</b> to check it, or paste a fresh key. Get one free at
           <a href="https://site.financialmodelingprep.com/developer/docs" target="_blank" rel="noopener">financialmodelingprep.com</a>.</p>`
        : `<p>Add a <b>free</b> Financial Modeling Prep API key (~30 seconds) in the <b>☰ Account</b> menu → Fundamentals data. Get one at
           <a href="https://site.financialmodelingprep.com/developer/docs" target="_blank" rel="noopener">financialmodelingprep.com</a>.</p>`
    }
  </div>`;
}

function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + (cls || "");
  const banner = $("demoBanner");
  if (banner) banner.classList.toggle("hidden", cls !== "warn");
}

// ---------------- Rendering (tier-aware) ----------------
function render(r, symbol, tier) {
  $("results").classList.remove("hidden");

  const finalScore = r.blendedScore != null ? r.blendedScore : r.score;
  const verdict = $("verdict");
  verdict.textContent = r.action;
  verdict.className = "verdict " + verdictClass(r.action);
  $("scoreVal").textContent = (finalScore >= 0 ? "+" : "") + finalScore;
  $("priceVal").textContent = "$" + fmt(r.price);

  // Dual Buy / Sell scores (1–50 each) — a friendlier read of the −100…+100
  // score. They split ~50 between them: a heavy sell shows e.g. Sell 47 / Buy 3.
  const buyScore = Math.max(1, Math.min(49, Math.round(((finalScore + 100) / 200) * 50)));
  const sellScore = 50 - buyScore;
  $("buyScore").textContent = buyScore + " / 50";
  $("sellScore").textContent = sellScore + " / 50";
  $("buyBar").style.width = (buyScore / 50) * 100 + "%";
  $("sellBar").style.width = (sellScore / 50) * 100 + "%";

  // Confidence — gated
  const confWrap = $("confBlock");
  if (tier.confidence) {
    confWrap.classList.remove("locked-stat");
    $("confVal").textContent = r.confidence + "%";
  } else {
    confWrap.classList.add("locked-stat");
    $("confVal").textContent = "🔒";
  }

  const pct = (finalScore + 100) / 2;
  $("gaugeFill").style.width = pct + "%";
  $("gaugeFill").style.background = gaugeColor(finalScore);

  // Plain-English summary — Pro
  const peCard = $("plainEnglishCard");
  if (tier.plainEnglish && r.plainEnglish) {
    peCard.classList.remove("hidden");
    $("plainEnglish").textContent = r.plainEnglish;
  } else {
    peCard.classList.add("hidden");
  }

  // Trade plan — gated
  const planCard = $("planCard");
  const planEl = $("plan");
  if (tier.tradePlan) {
    planCard.classList.remove("locked-card");
    const plan = r.plan;
    if (plan && plan.side !== "FLAT") {
      planEl.innerHTML = `
        <div class="plan-grid">
          <div><span class="k">Side</span><span class="v ${plan.side === "LONG" ? "buy" : "sell"}">${plan.side}</span></div>
          <div><span class="k">Entry</span><span class="v">$${fmt(plan.entry)}</span></div>
          <div><span class="k">Stop-loss</span><span class="v sell">$${fmt(plan.stop)}</span></div>
          <div><span class="k">Target</span><span class="v buy">$${fmt(plan.target)}</span></div>
          <div><span class="k">Risk / trade</span><span class="v">${plan.riskPct.toFixed(2)}%</span></div>
          <div><span class="k">Reward:Risk</span><span class="v">${plan.riskReward}:1</span></div>
        </div>
        <p class="plan-note">${plan.note}</p>`;
    } else {
      planEl.innerHTML = `<p class="plan-note">${plan ? plan.note : "No trade plan available."}</p>`;
    }
  } else {
    planEl.innerHTML = upsell("Trade plans (entry, stop-loss & target) are a Lite feature.");
  }

  // Snapshot chips — only for allowed indicators
  const s = r.snapshot;
  const allow = (k) => tier.voters === "all" || tier.voters.includes(k);
  const chips = [];
  if (allow("rsi")) chips.push(chip("RSI(14)", s.rsi?.toFixed(1), rsiTone(s.rsi)));
  if (allow("macd")) chips.push(chip("MACD hist", s.macdHist?.toFixed(4), s.macdHist > 0 ? "buy" : "sell"));
  if (allow("stoch")) chips.push(chip("Stoch %K", s.stochK?.toFixed(0)));
  chips.push(chip("SMA50", fmt(s.sma50)));
  chips.push(chip("SMA200", fmt(s.sma200)));
  if (tier.tradePlan) chips.push(chip("ATR(14)", fmt(s.atr)));
  if (tier.voters === "all") chips.push(chip("ADX", r.adx.adx?.toFixed(0), r.adx.adx > 25 ? "buy" : ""));
  // Volume confirmation: latest bar's volume vs its 20-bar average. >1.3× means
  // the current move is backed by real participation; <0.7× means thin/suspect.
  const relVol = relativeVolume(state.candles);
  if (relVol != null) {
    chips.push(chip("Rel. volume", relVol.toFixed(2) + "×", relVol >= 1.3 ? "buy" : relVol < 0.7 ? "sell" : ""));
  }
  $("snapshot").innerHTML = chips.join("");

  // Breakdown — allowed voters + an upsell row for the locked ones
  const shown = r.breakdown
    .map((b) => {
      const dir = b.vote > 0.15 ? "buy" : b.vote < -0.15 ? "sell" : "neutral";
      const label = b.vote > 0.15 ? "Bullish" : b.vote < -0.15 ? "Bearish" : "Neutral";
      const barW = Math.abs(b.vote) * 50;
      const barSide = b.vote >= 0 ? "left:50%" : "right:50%";
      return `
        <div class="row">
          <div class="row-head">
            <span class="ind-name">${prettyName(b.name)}</span>
            <span class="badge ${dir}">${label}</span>
            <span class="weight">w ${(b.weight * 100).toFixed(0)}%</span>
          </div>
          <div class="votebar"><span class="fill ${dir}" style="${barSide};width:${barW}%"></span></div>
          <div class="ind-note">${b.note}</div>
        </div>`;
    })
    .join("");
  const lockedCount = VOTER_KEYS.length - r.breakdown.length;
  const lockRow =
    lockedCount > 0
      ? `<div class="row lock-row" onclick="window.__openPricing()">🔒 <b>${lockedCount} more indicator${
          lockedCount > 1 ? "s" : ""
        }</b> (Stochastic, Bollinger, volume flow…) unlock on higher plans — click to upgrade.</div>`
      : "";
  $("breakdown").innerHTML = shown + lockRow;
  $("adxNote").textContent = tier.voters === "all" ? r.adx.note || "" : "";
  $("blendNote").textContent =
    r.blendedScore != null
      ? `Final score blends technicals (70%) + fundamentals (30%) → ${r.blendedScore >= 0 ? "+" : ""}${r.blendedScore}.`
      : "";

  // Fundamentals — Pro + crypto
  const fundWrap = $("fundamentals");
  if (tier.fundamentals) {
    fundWrap.classList.remove("hidden");
    if (r.fundScore && state.fundamentals) {
      const f = state.fundamentals;
      $("fundScore").textContent = (r.fundScore.score >= 0 ? "+" : "") + r.fundScore.score;
      $("fundScore").className = "mini-score " + (r.fundScore.score >= 0 ? "buy" : "sell");
      $("fundMetrics").innerHTML = [
        chip("Market cap", fmt(f.marketCap, { compact: true })),
        chip("Rank", f.marketCapRank ? "#" + f.marketCapRank : "—"),
        chip("24h vol", fmt(f.volume24h, { compact: true })),
        chip("24h", fmt(f.change24h, { pct: true }), f.change24h > 0 ? "buy" : "sell"),
        chip("7d", fmt(f.change7d, { pct: true }), f.change7d > 0 ? "buy" : "sell"),
        chip("30d", fmt(f.change30d, { pct: true }), f.change30d > 0 ? "buy" : "sell"),
        chip("From ATH", fmt(f.athChangePct, { pct: true })),
      ].join("");
      $("fundReasons").innerHTML = r.fundScore.reasons.map((x) => `<li>${x}</li>`).join("");
    } else {
      $("fundScore").textContent = "";
      $("fundScore").className = "mini-score";
      $("fundMetrics").innerHTML = "";
      $("fundReasons").innerHTML = `<li>Fundamentals are available for major crypto assets. Pick one (e.g. Bitcoin) to see market-cap, liquidity, ATH distance and momentum scoring.</li>`;
    }
  } else {
    fundWrap.classList.add("hidden");
  }

  renderDivergence(r, tier);
  buildChartTf(tier);
  scheduleChart(state.candles, r.indicators);
}

// ---------------- RSI divergence engine ----------------
function renderDivergence(r, tier) {
  const card = $("divCard");
  if (!card) return;
  if (!tier.confidence) { card.classList.add("hidden"); return; } // Lite+ analytics

  const rsi = r.indicators && r.indicators.rsi;
  const candles = state.candles;
  if (!Array.isArray(rsi) || !Array.isArray(candles) || candles.length < 20) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  const trendUp = r.snapshot.sma50 != null && r.snapshot.sma200 != null
    ? r.snapshot.sma50 > r.snapshot.sma200
    : r.snapshot.sma20 != null && r.snapshot.sma50 != null ? r.snapshot.sma20 > r.snapshot.sma50 : null;
  const context = { trendUp, adx: r.adx ? r.adx.adx : null };

  const det = detectDivergences(candles, rsi, context);
  const pivots = recentPivots(candles, { width: 3, lookback: 120 });
  const comp = compressionState(r.indicators.bollinger, 120);
  const tf = TF_LABELS[$("interval").value] || $("interval").value || "";
  const extras = { pivots, comp };
  const badge = $("divBadge");
  const content = $("divContent");

  // A one-line, plain caption that reads at a glance.
  const compBit = comp.available ? ` · price ${comp.compressing ? "compressing 🪢" : comp.label.toLowerCase()}` : "";
  const caption = (divWord) =>
    `<p class="div-caption">${esc(tf)} · ${pivots.highs.length + pivots.lows.length} recent pivots · ${divWord}${compBit}</p>`;

  if (!det.available) {
    badge.textContent = "";
    content.innerHTML = caption("divergence: n/a") +
      `<p class="val-empty-note">${esc(det.reason || "Divergence analysis unavailable.")}</p>`;
    drawDivViz(candles, rsi, null, extras);
    return;
  }

  const p = det.primary;
  if (!p) {
    badge.className = "div-badge";
    badge.textContent = "None active";
    const recent = det.all.slice(0, 1)[0];
    content.innerHTML = caption("divergence: none active") +
      `<p class="div-none">No active RSI divergence on the recent swings — price and momentum agree here${
        recent ? ` (last one, ${esc(recent.label.toLowerCase())}, was ${recent.barsAgo} bars ago)` : ""
      }. Red dots = swing highs, green = swing lows.</p>
      <p class="val-source">Regular divergence = momentum disagreeing with price (early warning). Hidden divergence = trend-continuation. Educational, not financial advice.</p>`;
    drawDivViz(candles, rsi, null, extras);
    return;
  }

  badge.className = "div-badge " + p.tone;
  badge.textContent = `${p.classification}`;

  const pricePhrase = p.pivotKind === "high"
    ? (p.price2 > p.price1 ? "higher high" : "lower high")
    : (p.price2 < p.price1 ? "lower low" : "higher low");
  const rsiPhrase = p.rsi2 > p.rsi1 ? "higher" : "lower";
  const rsiWord = p.pivotKind === "high" ? `${rsiPhrase} high` : `${rsiPhrase} low`;
  const others = det.active.filter((d) => d !== p).slice(0, 3);

  content.innerHTML = caption(`divergence: <b>${esc(p.label.toLowerCase())}</b>`) + `
    <div class="div-top">
      <div class="div-headline ${p.tone}">${esc(p.label)} divergence</div>
      <div class="div-strength">Strength <b>${p.strength}/100</b> · latest swing ${p.barsAgo} bar${p.barsAgo === 1 ? "" : "s"} ago</div>
    </div>
    <div class="div-facts">
      <div><span class="dk">Price</span><span class="dv">${esc(pricePhrase)} &nbsp;$${fmt(p.price1)} → $${fmt(p.price2)} <span class="dvm">(${p.priceDiffPct >= 0 ? "+" : ""}${p.priceDiffPct.toFixed(1)}%)</span></span></div>
      <div><span class="dk">RSI</span><span class="dv">${esc(rsiWord)} &nbsp;${p.rsi1.toFixed(0)} → ${p.rsi2.toFixed(0)} <span class="dvm">(${p.rsiDiff >= 0 ? "+" : ""}${p.rsiDiff.toFixed(0)})</span></span></div>
      <div><span class="dk">Key levels</span><span class="dv">$${fmt(Math.min(p.price1, p.price2))} · $${fmt(Math.max(p.price1, p.price2))}</span></div>
    </div>
    <p class="div-meaning">${esc(p.meaning)}</p>
    ${others.length ? `<div class="div-others"><span class="dk">Also active:</span> ${others.map((d) => `<span class="div-chip ${d.tone}">${esc(d.label)} · ${d.strength}</span>`).join(" ")}</div>` : ""}
    <p class="val-source">Detected from swing pivots (width 3) over the last ${Math.min(120, candles.length)} bars. A divergence is a momentum clue, not a guarantee — confirm with price action. Not financial advice.</p>`;

  drawDivViz(candles, rsi, p, extras);
}

// Self-contained price + RSI mini-chart: marks all recent swing pivots, shades
// price compression, and draws the primary divergence when present.
function drawDivViz(candles, rsi, prim, extras = {}) {
  const cv = $("divViz");
  if (!cv) return;
  const win = Math.min(120, candles.length);
  const start = candles.length - win;
  const wc = candles.slice(start);
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600;
  const h = 190;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const closes = wc.map((c) => c.close);
  const rs = rsi.slice(start);
  // Panel geometry with generous margins so nothing touches the edges.
  const padTop = 18, priceH = 106, rTop = 146, rH = 38; // price 18..124, gap, rsi 146..184
  // IMPORTANT: derive the price range from the actual highs/lows shown (pivot
  // dots sit at highs/lows), not just closes, so no marker ever clips off-panel.
  let pLo = Math.min(...wc.map((c) => c.low));
  let pHi = Math.max(...wc.map((c) => c.high));
  const padv = (pHi - pLo) * 0.08 || 1; pLo -= padv; pHi += padv;
  const xAt = (i) => (i / (win - 1)) * (w - 12) + 6;
  const pyAt = (v) => padTop + priceH * (1 - (v - pLo) / (pHi - pLo || 1));
  const ryAt = (v) => rTop + 1 + (rH - 2) * (1 - (v == null ? 0.5 : Math.max(0, Math.min(100, v)) / 100));

  // compression tint on the price panel (coiling = calm before a move)
  if (extras.comp && extras.comp.available && extras.comp.compressing) {
    ctx.fillStyle = "rgba(76,154,255,0.08)";
    ctx.fillRect(0, padTop - 6, w, priceH + 12);
  }

  // price line
  ctx.beginPath();
  closes.forEach((v, i) => (i ? ctx.lineTo(xAt(i), pyAt(v)) : ctx.moveTo(xAt(i), pyAt(v))));
  ctx.strokeStyle = "#8a94a6"; ctx.lineWidth = 1.5; ctx.stroke();

  // recent swing pivots — red = highs, green = lows (always shown)
  if (extras.pivots) {
    for (const idx of extras.pivots.highs) {
      const i = idx - start; if (i < 0) continue;
      ctx.beginPath(); ctx.arc(xAt(i), pyAt(candles[idx].high), 2.4, 0, Math.PI * 2);
      ctx.fillStyle = "#e23744"; ctx.fill();
    }
    for (const idx of extras.pivots.lows) {
      const i = idx - start; if (i < 0) continue;
      ctx.beginPath(); ctx.arc(xAt(i), pyAt(candles[idx].low), 2.4, 0, Math.PI * 2);
      ctx.fillStyle = "#16c784"; ctx.fill();
    }
  }

  // RSI 30/70 guides + line
  ctx.strokeStyle = "rgba(148,163,184,0.18)"; ctx.lineWidth = 1;
  [30, 50, 70].forEach((lvl) => { ctx.beginPath(); ctx.moveTo(0, ryAt(lvl)); ctx.lineTo(w, ryAt(lvl)); ctx.stroke(); });
  ctx.beginPath();
  let started = false;
  rs.forEach((v, i) => {
    if (v == null) return;
    if (!started) { ctx.moveTo(xAt(i), ryAt(v)); started = true; } else ctx.lineTo(xAt(i), ryAt(v));
  });
  ctx.strokeStyle = "#4c9aff"; ctx.lineWidth = 1.5; ctx.stroke();

  if (prim) {
    const color = prim.tone === "buy" ? "#16c784" : prim.tone === "sell" ? "#e23744" : "#d1b73a";
    const a = prim.idx1 - start, b = prim.idx2 - start;
    if (a >= 0 && b >= 0) {
      const pa = prim.pivotKind === "high" ? candles[prim.idx1].high : candles[prim.idx1].low;
      const pb = prim.pivotKind === "high" ? candles[prim.idx2].high : candles[prim.idx2].low;
      // price divergence line
      ctx.beginPath(); ctx.moveTo(xAt(a), pyAt(pa)); ctx.lineTo(xAt(b), pyAt(pb));
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.stroke();
      // rsi divergence line
      ctx.beginPath(); ctx.moveTo(xAt(a), ryAt(prim.rsi1)); ctx.lineTo(xAt(b), ryAt(prim.rsi2));
      ctx.stroke(); ctx.setLineDash([]);
      // pivot dots
      [[xAt(a), pyAt(pa)], [xAt(b), pyAt(pb)], [xAt(a), ryAt(prim.rsi1)], [xAt(b), ryAt(prim.rsi2)]].forEach(([x, y]) => {
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      });
    }
  }
  ctx.fillStyle = "#8a94a6"; ctx.font = "10px system-ui, sans-serif";
  ctx.fillText("Price", 4, 12); ctx.fillText("RSI", 4, rTop - 3);
}

// Draw on the next frame (after layout) and never let a draw error blank the UI.
function scheduleChart(candles, ind) {
  requestAnimationFrame(() => {
    const cv = $("chart");
    if (!cv) return;
    if (cv.clientWidth === 0) {
      setTimeout(() => scheduleChart(candles, ind), 120); // not laid out yet
      return;
    }
    try {
      drawChart(candles, ind);
    } catch (e) {
      console.error("chart draw failed:", e);
    }
  });
}

// ---------------- Market Regime engine ----------------
const REGIME_CACHE = "signaldesk_regime_v1";
const REGIME_TTL = 30 * 60 * 1000; // 30 min — internals don't change intraday-fast

async function loadMarketRegime(force = false) {
  const card = $("regimeCard");
  if (!card) return;

  // Serve a fresh-enough cache instantly.
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(REGIME_CACHE));
      if (cached && cached.reg && Date.now() - cached.reg.asOf < REGIME_TTL) {
        renderMarketRegime(cached.reg);
        return;
      }
    } catch { /* ignore */ }
  }

  card.classList.remove("hidden");
  $("regimeContent").innerHTML = `<p class="status loading">Reading the market's internals…</p>`;
  const results = await mapLimit(REGIME_SYMBOLS, 5, async (sym) => {
    try { return [sym, await fetchCandles(sym, "1d", 400)]; }
    catch { return [sym, null]; }
  });
  const data = {};
  for (const [sym, candles] of results) if (candles && candles.length) data[sym] = candles;

  const reg = computeMarketRegime(data);
  if (!reg.available) {
    $("regimeContent").innerHTML = `<p class="val-empty-note">${esc(reg.reason || "Market regime unavailable right now.")}</p>`;
    return;
  }
  try { localStorage.setItem(REGIME_CACHE, JSON.stringify({ reg })); } catch { /* ignore */ }
  renderMarketRegime(reg);
}

function renderMarketRegime(reg) {
  const card = $("regimeCard");
  if (!card) return;
  card.classList.remove("hidden");
  const ago = Math.round((Date.now() - reg.asOf) / 60000);
  const list = (arr, cls) => arr.length
    ? `<ul class="rg-list ${cls}">${arr.map((f) => `<li>${esc(f.note)}</li>`).join("")}</ul>`
    : `<p class="rg-none">—</p>`;
  $("regimeContent").innerHTML = `
    <div class="rg-top">
      <div class="rg-dial ${reg.tone}">${reg.score}<span>/100</span></div>
      <div class="rg-meta">
        <div class="rg-label ${reg.tone}">${esc(reg.label)}</div>
        <div class="rg-gauge"><span class="fill ${reg.tone}" style="width:${reg.score}%"></span></div>
        <div class="rg-sub">Risk appetite across indices, breadth, volatility, credit, rates &amp; the dollar · confidence ${reg.confidence}%${ago > 1 ? ` · ${ago}m ago` : ""}</div>
      </div>
    </div>
    <div class="rg-cols">
      <div><div class="rg-h buy">Supporting risk-on</div>${list(reg.supporting, "buy")}</div>
      <div><div class="rg-h sell">Contradicting</div>${list(reg.contradicting, "sell")}</div>
    </div>
    <p class="val-source">Educational market context, not financial advice. Aggregated from public index &amp; macro data; interpret as a backdrop, not a trade signal.</p>`;
}

// ---------------- News ticker ----------------
let newsTimer = null;
async function initNews() {
  await loadNews();
  if (newsTimer) clearInterval(newsTimer);
  newsTimer = setInterval(loadNews, 5 * 60 * 1000); // refresh every 5 min
}
async function loadNews() {
  let items = [];
  try {
    items = await fetchNews();
  } catch (e) {
    console.warn("news failed:", e);
  }
  const ticker = $("newsTicker");
  const track = $("newsTrack");
  if (!items.length) {
    ticker.classList.add("hidden");
    return;
  }
  track.innerHTML = "";
  // build twice for a seamless -50% loop; titles via textContent (untrusted source)
  const build = () => {
    for (const it of items) {
      const a = document.createElement("a");
      a.className = "news-item";
      a.href = it.url || "#";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      const tag = document.createElement("span");
      tag.className = "nt" + (it.tag === "MACRO" ? " macro" : /^(BTC|ETH|SOL|XRP|DOGE|BNB|ADA|AVAX)$/.test(it.tag) ? " up" : "");
      tag.textContent = it.tag;
      const t = document.createElement("span");
      t.textContent = it.title;
      a.append(tag, t);
      track.appendChild(a);
    }
  };
  build();
  build(); // duplicate for a seamless wrap-around loop
  ticker.classList.remove("hidden");
  startNewsAutoScroll();
}

// Slow, readable auto-scroll you can grab and hold. Pauses on hover, wheel,
// touch, or drag; resumes shortly after you let go.
let newsRAF = null;
let newsPaused = false;
let newsResumeTimer = null;
let newsWired = false;
function pauseNews() {
  newsPaused = true;
  clearTimeout(newsResumeTimer);
}
function resumeNewsSoon(ms = 2200) {
  clearTimeout(newsResumeTimer);
  newsResumeTimer = setTimeout(() => (newsPaused = false), ms);
}
function wireNewsInteractions(wrap) {
  if (newsWired) return;
  newsWired = true;
  wrap.addEventListener("mouseenter", pauseNews);
  wrap.addEventListener("mouseleave", () => resumeNewsSoon(500));
  wrap.addEventListener("wheel", () => { pauseNews(); resumeNewsSoon(); }, { passive: true });
  wrap.addEventListener("touchstart", pauseNews, { passive: true });
  wrap.addEventListener("touchmove", pauseNews, { passive: true });
  wrap.addEventListener("touchend", () => resumeNewsSoon(), { passive: true });
  // click-drag to scroll (desktop); suppresses the link click only if dragged
  let dragging = false, startX = 0, startScroll = 0, moved = 0;
  wrap.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragging = true; moved = 0; startX = e.clientX; startScroll = wrap.scrollLeft;
    pauseNews(); wrap.classList.add("grabbing");
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    wrap.scrollLeft = startScroll - dx;
  });
  const endDrag = () => { if (dragging) { dragging = false; wrap.classList.remove("grabbing"); resumeNewsSoon(); } };
  wrap.addEventListener("pointerup", endDrag);
  wrap.addEventListener("pointercancel", endDrag);
  wrap.addEventListener("pointerleave", endDrag);
  wrap.addEventListener("click", (e) => { if (moved > 6) { e.preventDefault(); e.stopPropagation(); } }, true);
}
let newsPos = 0;
function startNewsAutoScroll() {
  const wrap = $("newsTrackWrap");
  const track = $("newsTrack");
  if (!wrap || !track) return;
  wireNewsInteractions(wrap);
  if (newsRAF) cancelAnimationFrame(newsRAF);
  newsPos = wrap.scrollLeft;
  const speed = 0.4; // px/frame ≈ 24px/s — slow and easy to read
  const step = () => {
    if (newsPaused) {
      // stay in sync with whatever the user manually scrolled to
      newsPos = wrap.scrollLeft;
    } else if (document.visibilityState === "visible") {
      // accumulate in a float (scrollLeft snaps to int, so sub-pixel would stall)
      const half = track.scrollWidth / 2;
      newsPos += speed;
      if (half > 0 && newsPos >= half) newsPos -= half;
      wrap.scrollLeft = newsPos;
    }
    newsRAF = requestAnimationFrame(step);
  };
  newsRAF = requestAnimationFrame(step);
}

function upsell(msg) {
  return `<div class="upsell" onclick="window.__openPricing()">🔒 ${msg}<br><span class="upsell-cta">Upgrade →</span></div>`;
}

function chip(label, value, tone = "") {
  return `<div class="metric ${tone}"><span class="ml">${label}</span><span class="mv">${value ?? "—"}</span></div>`;
}
// Latest bar volume vs its trailing 20-bar average (participation check).
function relativeVolume(candles, period = 20) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const vols = candles.slice(-period - 1, -1).map((c) => c.volume || 0);
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
  const last = candles[candles.length - 1].volume || 0;
  return avg > 0 ? last / avg : null;
}
function rsiTone(v) {
  if (v == null) return "";
  if (v <= 30) return "buy";
  if (v >= 70) return "sell";
  return "";
}
function prettyName(k) {
  return {
    trend: "Trend structure (MA)",
    macd: "MACD",
    rsi: "RSI",
    stoch: "Stochastic",
    bollinger: "Bollinger Bands",
    emaCross: "EMA 12/26 cross",
    obv: "On-Balance Volume",
  }[k] || k;
}
function verdictClass(a) {
  if (a.includes("STRONG BUY")) return "strong-buy";
  if (a.includes("BUY")) return "buy";
  if (a.includes("STRONG SELL")) return "strong-sell";
  if (a.includes("SELL")) return "sell";
  return "hold";
}
function gaugeColor(score) {
  if (score >= 45) return "#16c784";
  if (score >= 18) return "#4cd3a5";
  if (score > -18) return "#c7b84c";
  if (score > -45) return "#ea5f6b";
  return "#e23744";
}

// ---------------- Chart (unchanged core) ----------------
// ---- Chart zoom / pan / hover / type state ----
const CHART_DEFAULT = 140;
const chartView = { count: CHART_DEFAULT, offset: 0 };
let chartType = (() => { try { return localStorage.getItem("signaldesk_charttype") || "candles"; } catch { return "candles"; } })();
const chartHover = { x: null, y: null };
let hoverRaf = null;
function scheduleHoverRedraw() {
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => { hoverRaf = null; redrawChart(); });
}
function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function resetChartView(len) {
  chartView.count = Math.min(CHART_DEFAULT, len || CHART_DEFAULT);
  chartView.offset = 0;
}
function redrawChart() {
  if (state.result) {
    try {
      drawChart(state.candles, state.result.indicators);
    } catch (e) {
      console.error("chart redraw failed:", e);
    }
  }
}
function chartZoom(factor) {
  if (!state.candles.length) return;
  const total = state.candles.length;
  const center = total - chartView.offset - chartView.count / 2; // keep view centered
  const nc = Math.max(20, Math.min(Math.round(chartView.count * factor), total));
  chartView.count = nc;
  chartView.offset = Math.max(0, Math.min(Math.round(total - center - nc / 2), total - nc));
  redrawChart();
}
function chartPanPixels(dx) {
  if (!state.candles.length) return;
  const cw = Math.max(50, $("chart").clientWidth - 66);
  const perPx = chartView.count / cw;
  const total = state.candles.length;
  chartView.offset = Math.max(0, Math.min(Math.round(chartView.offset + dx * perPx), total - chartView.count));
  redrawChart();
}
function wireChartInteractions() {
  const cv = $("chart");
  if (!cv || cv.dataset.wired) return;
  cv.dataset.wired = "1";
  cv.addEventListener("wheel", (e) => {
    if (!state.result) return;
    e.preventDefault();
    chartZoom(e.deltaY < 0 ? 0.85 : 1.18);
  }, { passive: false });
  const pts = new Map();
  let pinchDist = 0;
  let panning = false;
  let lastX = 0;
  cv.addEventListener("pointerdown", (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { panning = true; lastX = e.clientX; cv.style.cursor = "grabbing"; }
    else { panning = false; pinchDist = 0; }
    try { cv.setPointerCapture(e.pointerId); } catch {}
  });
  cv.addEventListener("pointermove", (e) => {
    if (!state.result) return;
    const rect = cv.getBoundingClientRect();
    chartHover.x = e.clientX - rect.left;
    chartHover.y = e.clientY - rect.top;
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) chartZoom(pinchDist / d);
      pinchDist = d;
    } else if (panning) {
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      chartPanPixels(dx); // this redraws (crosshair included)
    } else {
      scheduleHoverRedraw();
    }
  });
  const rm = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchDist = 0;
    if (pts.size === 0) { panning = false; cv.style.cursor = "grab"; }
    if (e.pointerType === "touch") { chartHover.x = null; scheduleHoverRedraw(); }
  };
  cv.addEventListener("pointerup", rm);
  cv.addEventListener("pointercancel", rm);
  cv.addEventListener("pointerleave", () => { chartHover.x = null; scheduleHoverRedraw(); });
  cv.style.cursor = "grab";
}

function drawChart(candles, ind) {
  const canvas = $("chart");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  // Windowed view for zoom/pan: count = candles shown, offset = bars back from end.
  const total = candles.length;
  let count = Math.max(20, Math.min(Math.round(chartView.count), total));
  let off = Math.max(0, Math.min(Math.round(chartView.offset), total - count));
  chartView.count = count;
  chartView.offset = off;
  const endIdx = total - off;
  const view = candles.slice(endIdx - count, endIdx);
  const offset = endIdx - count;
  const padL = 8;
  const padR = 58;
  const priceH = cssH * 0.72;
  const rsiTop = priceH + 24;
  const rsiH = cssH - rsiTop - 6;

  const highs = view.map((c) => c.high);
  const lows = view.map((c) => c.low);
  let max = Math.max(...highs);
  let min = Math.min(...lows);
  // Auto-scale to include every overlay that gets drawn (SMA 20/50/200 and the
  // Bollinger bands), so none of those lines render off the top/bottom edge.
  for (const arr of [ind.sma20, ind.sma50, ind.sma200, ind.bollinger && ind.bollinger.upper, ind.bollinger && ind.bollinger.lower]) {
    if (!arr) continue;
    for (let i = 0; i < view.length; i++) {
      const v = arr[offset + i];
      if (v == null) continue;
      if (v > max) max = v;
      if (v < min) min = v;
    }
  }
  const padY = (max - min) * 0.08;
  max += padY;
  min -= padY;
  const x = (i) => padL + (i / (view.length - 1)) * (cssW - padL - padR);
  const y = (p) => 8 + (1 - (p - min) / (max - min)) * (priceH - 16);

  ctx.font = "10px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  for (let g = 0; g <= 4; g++) {
    const p = min + (g / 4) * (max - min);
    const yy = y(p);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(cssW - padR, yy);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.textAlign = "left";
    ctx.fillText(fmt(p), cssW - padR + 4, yy);
  }

  const bw0 = (cssW - padL - padR) / view.length;

  // volume overlay — bottom ~16% of the price panel, behind the price series
  const volAreaTop = priceH - 8 - (priceH - 16) * 0.16;
  const volMax = Math.max(...view.map((c) => c.volume || 0)) || 1;
  for (let i = 0; i < view.length; i++) {
    const c = view[i];
    const up = c.close >= c.open;
    const vh = ((c.volume || 0) / volMax) * (priceH - 8 - volAreaTop);
    ctx.fillStyle = up ? "rgba(22,199,132,0.22)" : "rgba(226,55,68,0.22)";
    ctx.fillRect(x(i) - bw0 * 0.3, priceH - 8 - vh, bw0 * 0.6, vh);
  }

  // price series — candles / line / area
  if (chartType === "candles") {
    const cw = Math.max(1.5, bw0 * 0.62);
    for (let i = 0; i < view.length; i++) {
      const c = view[i];
      const up = c.close >= c.open;
      ctx.strokeStyle = up ? "#16c784" : "#e23744";
      ctx.fillStyle = up ? "#16c784" : "#e23744";
      const xi = x(i);
      ctx.beginPath();
      ctx.moveTo(xi, y(c.high));
      ctx.lineTo(xi, y(c.low));
      ctx.stroke();
      const yo = y(c.open);
      const yc = y(c.close);
      ctx.fillRect(xi - cw / 2, Math.min(yo, yc), cw, Math.max(1, Math.abs(yc - yo)));
    }
  } else {
    const pts = view.map((c, i) => [x(i), y(c.close)]);
    if (chartType === "area") {
      const grad = ctx.createLinearGradient(0, 8, 0, priceH);
      grad.addColorStop(0, "rgba(76,154,255,0.35)");
      grad.addColorStop(1, "rgba(76,154,255,0)");
      ctx.beginPath();
      ctx.moveTo(pts[0][0], priceH - 8);
      pts.forEach(([px, py]) => ctx.lineTo(px, py));
      ctx.lineTo(pts[pts.length - 1][0], priceH - 8);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.strokeStyle = "#4c9aff";
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }

  const overlay = (arr, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < view.length; i++) {
      const v = arr[offset + i];
      if (v == null) continue;
      const px = x(i);
      const py = y(v);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  };
  overlay(ind.sma20, "#4c9aff");
  overlay(ind.sma50, "#f5a623");
  overlay(ind.sma200, "#b06cff");
  overlay(ind.bollinger.upper, "rgba(255,255,255,0.25)");
  overlay(ind.bollinger.lower, "rgba(255,255,255,0.25)");

  ctx.textAlign = "left";
  [
    ["SMA20", "#4c9aff"],
    ["SMA50", "#f5a623"],
    ["SMA200", "#b06cff"],
  ].forEach(([t, col], idx) => {
    const lx = padL + idx * 62;
    ctx.fillStyle = col;
    ctx.fillRect(lx, 10, 10, 3);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillText(t, lx + 14, 12);
  });

  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillText("RSI(14)", padL, rsiTop - 8);
  const ry = (v) => rsiTop + (1 - v / 100) * rsiH;
  [30, 70].forEach((lvl) => {
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.moveTo(padL, ry(lvl));
    ctx.lineTo(cssW - padR, ry(lvl));
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fillText(String(lvl), cssW - padR + 4, ry(lvl));
  });
  ctx.strokeStyle = "#00d1b2";
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < view.length; i++) {
    const v = ind.rsi[offset + i];
    if (v == null) continue;
    const px = x(i);
    const py = ry(v);
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // ---- crosshair + hover readout ----
  if (chartHover.x != null && view.length > 1) {
    const plotW = cssW - padL - padR;
    let idx = Math.round(((chartHover.x - padL) / plotW) * (view.length - 1));
    idx = Math.max(0, Math.min(idx, view.length - 1));
    const c = view[idx];
    const hx = x(idx);
    const hy = Math.max(8, Math.min(chartHover.y, priceH - 8));
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, 8); ctx.lineTo(hx, priceH - 6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, hy); ctx.lineTo(cssW - padR, hy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(hx, y(c.close), 2.6, 0, Math.PI * 2); ctx.fill();
    // price tag on the right axis at cursor height
    const pAtY = min + (1 - (hy - 8) / (priceH - 16)) * (max - min);
    ctx.fillStyle = "rgba(76,154,255,0.92)";
    ctx.fillRect(cssW - padR + 1, hy - 8, padR - 2, 16);
    ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.font = "10px ui-monospace, monospace"; ctx.textBaseline = "middle";
    ctx.fillText(fmt(pAtY), cssW - padR + 4, hy);
    // OHLC tooltip
    const rsiV = ind.rsi[offset + idx];
    const chg = c.open ? ((c.close - c.open) / c.open) * 100 : 0;
    const lines = [
      new Date(c.time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
      `O ${fmt(c.open)}   H ${fmt(c.high)}`,
      `L ${fmt(c.low)}   C ${fmt(c.close)}`,
      `Chg ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%${rsiV != null ? `   RSI ${rsiV.toFixed(0)}` : ""}`,
    ];
    ctx.font = "11px ui-monospace, monospace"; ctx.textBaseline = "top";
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    const th = lines.length * 15 + 10;
    let tx = hx + 14; if (tx + tw > cssW - padR) tx = hx - tw - 14; if (tx < padL) tx = padL;
    const ty = 10;
    ctx.fillStyle = "rgba(13,18,26,0.94)"; ctx.strokeStyle = "rgba(255,255,255,0.14)"; ctx.lineWidth = 1;
    roundRect(ctx, tx, ty, tw, th, 7); ctx.fill(); ctx.stroke();
    ctx.textAlign = "left";
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? "#fff" : i === 3 ? (chg >= 0 ? "#4cd3a5" : "#ef8e97") : "rgba(230,235,242,0.85)";
      ctx.fillText(l, tx + 8, ty + 6 + i * 15);
    });
    ctx.textBaseline = "middle";
  }
}

// ---------------- Controls / tier UI ----------------
function buildPresetOptions() {
  const sel = $("preset");
  sel.innerHTML = '<option value="">— quick pick an asset —</option>';
  for (const g of PRESET_GROUPS) {
    const og = document.createElement("optgroup");
    og.label = g.group;
    for (const it of g.items) {
      const o = document.createElement("option");
      o.value = it.symbol;
      o.textContent = `${it.label} (${it.symbol})`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}

// Quick timeframe buttons under the chart (mirror the dropdown, respect tier).
function buildChartTf(tier) {
  const box = $("chartTf");
  if (!box) return;
  const cur = $("interval").value;
  box.innerHTML = tier.timeframes
    .map((tf) => `<button class="tf-btn${tf === cur ? " active" : ""}" data-tf="${tf}">${TF_LABELS[tf] || tf}</button>`)
    .join("");
  box.querySelectorAll(".tf-btn").forEach((b) => {
    b.onclick = () => {
      $("interval").value = b.dataset.tf;
      run();
    };
  });
}

function buildIntervalOptions(tier) {
  const sel = $("interval");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const tf of tier.timeframes) {
    const o = document.createElement("option");
    o.value = tf;
    o.textContent = TF_LABELS[tf] || tf;
    sel.appendChild(o);
  }
  if (tier.timeframes.includes(prev)) sel.value = prev;
  else sel.value = tier.timeframes.includes("1d") ? "1d" : tier.timeframes[tier.timeframes.length - 1];
}

function renderUserBar() {
  const u = auth.getUser();
  const tier = currentTier();
  $("userEmail").textContent = u ? u.email : "not signed in";
  const dev = !u && DEV_FULL_ACCESS;
  const badge = $("tierBadge");
  badge.textContent = tier.name.toUpperCase() + (u && u.owner ? " · OWNER" : dev ? " · DEV" : "");
  badge.className = "tier-badge t-" + tier.id;

  // "Preview tier" selector — available to the owner and in dev mode, for
  // testing what each plan's gating looks like.
  const ownerBox = $("ownerViewAs");
  const canPreview = dev || (u && u.owner);
  if (canPreview) {
    ownerBox.classList.remove("hidden");
    const sel = $("viewAsSel");
    if (sel.options.length === 0) {
      TIER_ORDER.forEach((id) => {
        const o = document.createElement("option");
        o.value = id;
        o.textContent = "Preview as " + TIERS[id].name;
        sel.appendChild(o);
      });
    }
    sel.value = auth.getViewAs() || (u && u.owner ? "pro" : "pro");
  } else {
    ownerBox.classList.add("hidden");
  }

  // login vs logout affordances
  const loginBtn = $("loginBtn");
  const logoutBtn = $("logoutBtn");
  if (loginBtn) loginBtn.classList.toggle("hidden", !!u);
  if (logoutBtn) logoutBtn.classList.toggle("hidden", !u);
}

function applyTier() {
  const tier = currentTier();
  buildIntervalOptions(tier);
  renderUserBar();
  refreshTabLocks();
}

// ---------------- Pricing modal ----------------
function openPricing() {
  const grid = $("pricingGrid");
  const activeId = auth.effectiveTierId();
  const u = auth.getUser();
  grid.innerHTML = TIER_ORDER.map((id) => {
    const t = TIERS[id];
    const isActive = id === activeId;
    const perks = t.perks.map((p) => `<li class="yes">${p}</li>`).join("");
    const locked = t.locked.map((p) => `<li class="no">${p}</li>`).join("");
    const btn = isActive
      ? `<button class="tier-btn current" disabled>Current plan</button>`
      : `<button class="tier-btn" onclick="window.__choosePlan('${id}')">${
          u && u.owner ? "Preview " + t.name : "Choose " + t.name
        }</button>`;
    return `
      <div class="tier-card ${isActive ? "active" : ""} t-${id}">
        <div class="tier-name">${t.name}</div>
        <div class="tier-price">${t.price}<span>${t.priceNote}</span></div>
        <div class="tier-tagline">${t.tagline}</div>
        <ul class="tier-perks">${perks}${locked}</ul>
        ${btn}
      </div>`;
  }).join("");
  $("pricingModal").classList.remove("hidden");
}
function closePricing() {
  $("pricingModal").classList.add("hidden");
}
function choosePlan(id) {
  const u = auth.getUser();
  if (u && u.owner) {
    auth.setViewAs(id); // owners preview, real tier stays Pro
  } else {
    auth.setTier(id); // demo "subscribe"
  }
  closePricing();
  applyTier();
  if (state.result) run();
}

// ---------------- Auth flow ----------------
function showAuth() {
  $("authOverlay").classList.remove("hidden");
  $("appRoot").classList.add("hidden");
}
function hideAuth() {
  $("authOverlay").classList.add("hidden");
  $("appRoot").classList.remove("hidden");
}
function setAuthMode(mode) {
  $("authTitle").textContent = mode === "signup" ? "Create your account" : "Welcome back";
  $("authSubmit").textContent = mode === "signup" ? "Sign up — free" : "Log in";
  $("authToggle").innerHTML =
    mode === "signup"
      ? `Already have an account? <a href="#" id="toLogin">Log in</a>`
      : `New here? <a href="#" id="toSignup">Create a free account</a>`;
  $("authForm").dataset.mode = mode;
  $("authError").textContent = "";
  const t = document.getElementById("toLogin");
  const s = document.getElementById("toSignup");
  if (t) t.onclick = (e) => { e.preventDefault(); setAuthMode("login"); };
  if (s) s.onclick = (e) => { e.preventDefault(); setAuthMode("signup"); };
}
function submitAuth(e) {
  e.preventDefault();
  const mode = $("authForm").dataset.mode;
  const email = $("authEmail").value;
  const pass = $("authPass").value;
  const res = mode === "signup" ? auth.signup(email, pass) : auth.login(email, pass);
  if (res.error) {
    $("authError").textContent = res.error;
    return;
  }
  hideAuth();
  applyTier();
  run();
  initNews();
}

// Equity-curve line chart for the paper portfolio.
function drawEquityChart(equity) {
  const canvas = $("pfChart");
  if (!canvas || canvas.clientWidth === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const pts = (equity || []).filter((p) => p && Number.isFinite(p.total));
  if (pts.length < 2) {
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "12px system-ui";
    ctx.fillText("Make a few trades / revisits to build your performance curve.", 12, H / 2);
    return;
  }
  const base = portfolio.STARTING_CASH;
  const vals = pts.map((p) => p.total).concat(base);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  const pad = (max - min) * 0.1 || max * 0.02;
  min -= pad;
  max += pad;
  const padL = 8;
  const padR = 62;
  const x = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const y = (val) => 10 + (1 - (val - min) / (max - min)) * (H - 26);

  // baseline (starting cash)
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, y(base));
  ctx.lineTo(W - padR, y(base));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText("$" + fmt(base), W - padR + 4, y(base));

  const up = pts[pts.length - 1].total >= base;
  const color = up ? "#16c784" : "#e23744";
  // area fill
  const grad = ctx.createLinearGradient(0, 10, 0, H);
  grad.addColorStop(0, up ? "rgba(22,199,132,0.25)" : "rgba(226,55,68,0.25)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.moveTo(x(0), y(pts[0].total));
  pts.forEach((p, i) => ctx.lineTo(x(i), y(p.total)));
  ctx.lineTo(x(pts.length - 1), H);
  ctx.lineTo(x(0), H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  // line
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.total)) : ctx.moveTo(x(i), y(p.total))));
  ctx.stroke();
  // last value label
  ctx.fillStyle = color;
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillText("$" + fmt(pts[pts.length - 1].total), W - padR + 4, y(pts[pts.length - 1].total));
}

// ---------------- Portfolio Doctor ----------------
// Parse pasted / CSV holdings into [{symbol, shares, value}]. Flexible: accepts
// "AAPL 50", "AAPL,50", broker CSVs with Symbol/Quantity/Market-Value columns.
function parseHoldings(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  // Detect a header row for CSV column mapping.
  let symCol = -1, qtyCol = -1, valCol = -1, startIdx = 0;
  const headCells = lines[0].split(/[,\t]/).map((c) => c.trim().toLowerCase());
  if (headCells.some((c) => /symbol|ticker/.test(c))) {
    headCells.forEach((c, i) => {
      if (symCol < 0 && /symbol|ticker/.test(c)) symCol = i;
      if (qtyCol < 0 && /quantity|shares|qty|units/.test(c)) qtyCol = i;
      if (valCol < 0 && /market ?value|value|amount|balance/.test(c)) valCol = i;
    });
    startIdx = 1;
  }
  const out = [];
  for (let i = startIdx; i < lines.length; i++) {
    const cells = lines[i].split(/[,\t]/).map((c) => c.trim());
    let symbol, shares, value;
    if (symCol >= 0) {
      symbol = cells[symCol];
      shares = qtyCol >= 0 ? parseNum(cells[qtyCol]) : null;
      value = valCol >= 0 ? parseNum(cells[valCol]) : null;
    } else {
      // free-form: first token that looks like a ticker, then up to two numbers
      const tokens = lines[i].split(/[\s,]+/).filter(Boolean);
      symbol = tokens.find((t) => /^[\^]?[A-Za-z][A-Za-z0-9.\-=]{0,9}$/.test(t));
      const nums = tokens.map(parseNum).filter((n) => n != null);
      shares = nums[0] ?? null;
      value = nums[1] ?? null;
    }
    if (!symbol) continue;
    symbol = symbol.toUpperCase().replace(/[^A-Z0-9.\-=^]/g, "");
    if (!symbol) continue;
    out.push({ symbol, shares, value });
  }
  // merge duplicates
  const merged = {};
  for (const h of out) {
    if (!merged[h.symbol]) merged[h.symbol] = { symbol: h.symbol, shares: 0, value: 0, hasShares: false, hasValue: false };
    if (h.shares != null) { merged[h.symbol].shares += h.shares; merged[h.symbol].hasShares = true; }
    if (h.value != null) { merged[h.symbol].value += h.value; merged[h.symbol].hasValue = true; }
  }
  return Object.values(merged);
}
function parseNum(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function assetType(symbol) {
  if (looksLikeCrypto(symbol) || /-USD$/.test(symbol)) return "Crypto";
  if (/=X$/.test(symbol)) return "Forex";
  if (/=F$/.test(symbol)) return "Commodity";
  if (/^\^/.test(symbol)) return "Index";
  const etfs = new Set(WATCHLISTS.flatMap((w) => (w.id.includes("growth") || w.id.includes("dividend") ? w.items.map((i) => i.symbol) : [])));
  if (etfs.has(symbol) || /ETF/i.test(symbol)) return "ETF/Fund";
  return "Stock";
}

// Export the Portfolio Doctor report as PDF (via print) or a PNG image.
function exportDoctorPdf() {
  document.body.classList.add("printing-doctor");
  const prevTitle = document.title;
  document.title = "SignalDesk Portfolio Doctor";
  const cleanup = () => {
    document.body.classList.remove("printing-doctor");
    document.title = prevTitle;
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
  setTimeout(cleanup, 1500);
}

// Dependency-free DOM→PNG using an SVG <foreignObject> snapshot.
async function nodeToPng(node) {
  const w = Math.ceil(node.scrollWidth) || 800;
  const h = Math.ceil(node.scrollHeight) || 600;
  let css = "";
  for (const sheet of document.styleSheets) {
    try {
      css += [...(sheet.cssRules || [])].map((r) => r.cssText).join("");
    } catch {
      /* cross-origin sheet — skip */
    }
  }
  const clone = node.cloneNode(true);
  const wrapper = document.createElement("div");
  wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  wrapper.style.cssText = `width:${w}px;background:#0b0e13;padding:18px;color:#e6ebf2;font-family:Inter,system-ui,sans-serif`;
  wrapper.appendChild(clone);
  const xml = new XMLSerializer().serializeToString(wrapper);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + 40}"><foreignObject width="100%" height="100%"><style>${css}</style>${xml}</foreignObject></svg>`;
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error("render failed"));
    img.src = url;
  });
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = (h + 40) * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#0b0e13";
  ctx.fillRect(0, 0, w, h + 40);
  ctx.drawImage(img, 0, 0);
  return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("blob failed"))), "image/png"));
}
async function exportDoctorPng() {
  const btn = $("dlPng");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Rendering…";
  try {
    const blob = await nodeToPng($("doctorReport"));
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "portfolio-doctor.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } catch (e) {
    console.error("PNG export failed:", e);
    alert("Couldn't render an image in this browser. Use “Save as PDF” instead — the print dialog can save a PDF (or an image) of the report.");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function dclamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---- Screenshot → holdings (OCR) ----
// Tesseract.js is heavy, so it's loaded lazily from a CDN only when the user
// actually uploads an image. The app stays dependency-free until then.
let tesseractPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractPromise) return tesseractPromise;
  tesseractPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
    s.async = true;
    s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error("OCR library failed to initialize")));
    s.onerror = () => reject(new Error("could not load the OCR library (are you offline?)"));
    document.head.appendChild(s);
    setTimeout(() => { if (!window.Tesseract) reject(new Error("OCR library timed out")); }, 25000);
  });
  return tesseractPromise;
}

// Best-effort extraction of "TICKER qty" lines from noisy OCR text. Deliberately
// conservative — the user reviews/edits the result before analyzing.
const OCR_STOPWORDS = new Set([
  "THE", "AND", "INC", "CORP", "LTD", "PLC", "CO", "USD", "USDT", "ETF", "FUND", "YOUR", "TOTAL",
  "VALUE", "SHARES", "SHARE", "QTY", "MARKET", "GAIN", "LOSS", "TODAY", "PRICE", "COST", "AVG",
  "ALL", "CASH", "BUY", "SELL", "OPEN", "HIGH", "LOW", "DAY", "YR", "PName ", "NAME", "TYPE",
  "STOCK", "CRYPTO", "OPTION", "ACCOUNT", "PORTFOLIO", "HOLDINGS", "POSITIONS", "RETURN", "PL",
]);
function extractHoldingsFromOcr(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const tickers = [...line.matchAll(/\b([A-Z]{1,5}(?:[.\-][A-Z]{1,4})?)\b/g)]
      .map((m) => m[1])
      .filter((t) => !OCR_STOPWORDS.has(t) && !/^[A-Z]$/.test(t));
    if (!tickers.length) continue;
    const tick = tickers[0];
    if (seen.has(tick)) continue;
    // numbers on the line (shares/qty is usually the first plain number)
    const nums = [...line.matchAll(/(?<![A-Z])\$?\s?([\d]{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g)]
      .map((m) => parseFloat(m[1].replace(/,/g, "")))
      .filter((n) => Number.isFinite(n) && n > 0);
    const qty = nums.length ? nums[0] : "";
    seen.add(tick);
    out.push(`${tick}${qty !== "" ? " " + qty : ""}`);
  }
  return out;
}

async function handleImageUpload(file) {
  const msg = $("ocrMsg");
  msg.className = "ocr-msg";
  msg.textContent = "Loading text-recognition… (first use downloads a few MB).";
  try {
    const T = await loadTesseract();
    msg.textContent = "Reading your screenshot…";
    const { data } = await T.recognize(file, "eng", {
      logger: (m) => {
        if (m.status === "recognizing text") msg.textContent = `Reading your screenshot… ${Math.round((m.progress || 0) * 100)}%`;
      },
    });
    const found = extractHoldingsFromOcr(data && data.text);
    if (!found.length) {
      msg.className = "ocr-msg err";
      msg.textContent = "Couldn't pick out tickers from that image. Try a sharper crop of just the holdings list, or type/paste them below.";
      return;
    }
    const box = $("holdingsInput");
    const existing = box.value.trim();
    box.value = (existing ? existing + "\n" : "") + found.join("\n");
    try { localStorage.setItem("signaldesk_doctor_holdings", box.value); } catch {}
    msg.className = "ocr-msg ok";
    msg.textContent = `Found ${found.length} ticker${found.length > 1 ? "s" : ""} — please check the quantities below (OCR isn't perfect), then hit Analyze.`;
  } catch (e) {
    msg.className = "ocr-msg err";
    msg.textContent = "Screenshot reading unavailable: " + e.message + ". You can still paste tickers or upload a CSV.";
  }
}

// ---- Sell-priority ranking (which to sell first) ----
// Blends the technical signal, portfolio concentration, and the accumulation/
// distribution radar into a 0–100 "sell sooner" score.
function sellPriority(r) {
  if (!r.ok) return -1;
  let p = dclamp(50 - r.score * 0.6, 0, 100); // bearish signal → higher
  if (r.weight != null && r.weight > 0.2) p += dclamp((r.weight - 0.2) * 200, 0, 25); // concentration
  if (r.rec.verdict === "SELL") p += 15;
  else if (r.rec.verdict === "TRIM") p += 8;
  if (r.accum && r.accum.available) {
    if (r.accum.score <= 40) p += dclamp((45 - r.accum.score) * 0.5, 0, 15); // distribution
    else if (r.accum.score >= 60) p -= dclamp((r.accum.score - 55) * 0.4, 0, 12); // accumulating → hold
  }
  return dclamp(Math.round(p), 0, 100);
}
function sellReasons(r) {
  const out = [];
  if (r.score <= -18) out.push(`Bearish signal (${r.score})`);
  else if (r.score < 18) out.push("Weak / mixed signal");
  if (r.weight != null && r.weight > 0.25) out.push(`Overweight ${(r.weight * 100).toFixed(0)}%`);
  if (r.accum && r.accum.available && r.accum.score <= 40) out.push(`Money leaving (radar ${r.accum.score})`);
  if (!out.length) out.push("Trimming candidate");
  return out;
}
function sellSuggestion(r) {
  if (r.rec.verdict === "SELL") return "Exit / sell";
  if (r.weight != null && r.weight > 0.25) return "Trim toward ≤20%";
  return "Trim / reduce";
}

let doctorBusy = false;
async function runDoctor() {
  if (doctorBusy) return;
  const text = $("holdingsInput").value;
  try { localStorage.setItem("signaldesk_doctor_holdings", text); } catch {}
  const holdings = parseHoldings(text);
  const out = $("doctorResults");
  $("doctorExport").classList.add("hidden");
  if (!holdings.length) {
    out.innerHTML = `<p class="section-intro">Paste your holdings above (one per line, e.g. <code>AAPL 50</code>) or upload a CSV, then click Analyze.</p>`;
    return;
  }
  doctorBusy = true;
  $("runDoctor").disabled = true;
  out.innerHTML = `<p class="status loading">Analyzing ${holdings.length} holdings at live prices…</p>`;

  // Fetch + analyze each holding
  const rows = await mapLimit(holdings, 4, async (h) => {
    try {
      const candles = await fetchCandles(h.symbol, "1d", 400);
      const res = analyze(candles);
      const price = res.price;
      const value = h.hasValue ? h.value : h.hasShares ? h.shares * price : null;
      // accumulation/distribution read (cheap, pure from the candles we just fetched)
      let accum = null;
      try { accum = accumulationScore(candles); } catch { /* ignore */ }
      return { ...h, price, value, score: res.score, action: res.action, accum, ok: true };
    } catch (e) {
      return { ...h, ok: false, error: e.message };
    }
  });

  const valued = rows.filter((r) => r.ok && r.value != null);
  const totalValue = valued.reduce((s, r) => s + r.value, 0);
  // equal-weight fallback if no values supplied
  const okRows = rows.filter((r) => r.ok);
  const weightOf = (r) =>
    totalValue > 0 && r.value != null ? r.value / totalValue : okRows.length ? 1 / okRows.length : null;

  const analyzed = rows.map((r) => {
    if (!r.ok) return { ...r, weight: null, rec: { verdict: "N/A", tone: "neutral", reason: "Couldn't fetch data for this symbol — check the ticker." } };
    const weight = weightOf(r);
    const withRec = { ...r, weight, type: assetType(r.symbol), rec: recommend(r.score, weight) };
    withRec.sellP = sellPriority(withRec);
    return withRec;
  });
  analyzed.sort((a, b) => (b.weight || 0) - (a.weight || 0));

  renderDoctor(analyzed, totalValue);
  $("doctorExport").classList.remove("hidden");

  // Ideas to add: strong-signal candidates not already held
  const held = new Set(okRows.map((r) => r.symbol));
  const candidates = ADD_CANDIDATES.filter((c) => !held.has(c)).slice(0, 8);
  const ideas = await mapLimit(candidates, 4, async (sym) => {
    try {
      const res = analyze(await fetchCandles(sym, "1d", 400));
      return { symbol: sym, score: res.score, action: res.action };
    } catch {
      return null;
    }
  });
  renderIdeas(ideas.filter((x) => x && x.score >= 18).sort((a, b) => b.score - a.score).slice(0, 5));

  doctorBusy = false;
  $("runDoctor").disabled = false;
}

function renderDoctor(rows, totalValue) {
  const counts = { ADD: 0, KEEP: 0, HOLD: 0, TRIM: 0, SELL: 0 };
  rows.forEach((r) => { if (counts[r.rec.verdict] != null) counts[r.rec.verdict]++; });
  const types = {};
  rows.forEach((r) => { if (r.ok) types[r.type] = (types[r.type] || 0) + (r.weight || 0); });
  const topWeight = rows.length && rows[0].weight != null ? rows[0].weight : 0;
  const hhi = rows.reduce((s, r) => s + (r.weight ? r.weight * r.weight : 0), 0);
  const divScore = Math.max(0, Math.round((1 - hhi) * 100)); // 100 = well spread

  const summary = `
    <div class="doc-summary">
      <div class="pf-stat"><div class="l">Holdings</div><div class="n">${rows.length}</div></div>
      <div class="pf-stat"><div class="l">Est. value</div><div class="n">${totalValue > 0 ? "$" + fmt(totalValue) : "—"}</div></div>
      <div class="pf-stat"><div class="l">Diversification</div><div class="n ${divScore >= 60 ? "buy" : divScore >= 40 ? "" : "sell"}">${divScore}/100</div></div>
      <div class="pf-stat"><div class="l">Top position</div><div class="n ${topWeight > 0.25 ? "sell" : ""}">${topWeight ? (topWeight * 100).toFixed(0) + "%" : "—"}</div></div>
    </div>
    <div class="doc-verdicts">
      ${["ADD", "KEEP", "HOLD", "TRIM", "SELL"].map((k) => `<span class="dv dv-${k.toLowerCase()}">${counts[k]} ${k}</span>`).join("")}
    </div>
    <p class="doc-note">${diversificationNote(types, topWeight, divScore)}</p>`;

  const table = `
    <div class="table-wrap"><table class="pf-table">
      <thead><tr><th>Symbol</th><th>Type</th><th>Weight</th><th>Price</th><th>Signal</th><th>Action</th><th>Why</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td><b>${esc(r.symbol)}</b></td>
          <td>${r.ok ? esc(r.type) : "—"}</td>
          <td>${r.weight != null ? (r.weight * 100).toFixed(1) + "%" : "—"}</td>
          <td>${r.ok ? "$" + fmt(r.price) : "—"}</td>
          <td>${r.ok ? (r.score >= 0 ? "+" : "") + r.score : "—"}</td>
          <td><span class="dv dv-${r.rec.verdict.toLowerCase()}">${r.rec.verdict}</span></td>
          <td class="doc-reason">${esc(r.rec.reason)}</td>
        </tr>`).join("")}</tbody>
    </table></div>`;

  const header = `<div class="report-head">
      <div class="report-brand"><span class="spark">▲</span> SignalDesk · Portfolio Doctor</div>
      <div class="report-date">${rows.length} holdings · ${new Date().toLocaleString()}</div>
    </div>`;
  $("doctorResults").innerHTML = header + summary + sellSection(rows) + table;
  wireDoctorRowClicks($("doctorResults"));
}

// The "best to sell first" ranked area — the headline of the report.
function sellSection(rows) {
  const candidates = rows
    .filter((r) => r.ok && (r.sellP >= 55 || r.rec.verdict === "SELL" || r.rec.verdict === "TRIM"))
    .sort((a, b) => b.sellP - a.sellP)
    .slice(0, 6);

  if (!candidates.length) {
    return `<div class="sell-board sell-board-clear">
      <h2>🔻 Best to sell first</h2>
      <p class="sell-clear-note">✅ Nothing is screaming “sell” right now — every holding's signal is at least neutral and no position looks like it's being distributed. Keep your stops in place and re-check after big moves.</p>
    </div>`;
  }

  const items = candidates
    .map((r, i) => {
      const tone = r.sellP >= 70 ? "sell" : "warn";
      const chips = sellReasons(r).map((c) => `<span class="sell-chip">${esc(c)}</span>`).join("");
      return `<div class="sell-row" data-sym="${esc(r.symbol)}">
        <div class="sell-rank">${i + 1}</div>
        <div class="sell-main">
          <div class="sell-line1"><span class="sell-sym">${esc(r.symbol)}</span>
            <span class="sell-type">${esc(r.type || "")}</span>
            <span class="dv dv-${r.rec.verdict.toLowerCase()}">${r.rec.verdict}</span>
            <span class="sell-action">${esc(sellSuggestion(r))}</span></div>
          <div class="sell-chips">${chips}</div>
        </div>
        <div class="sell-meter" title="Sell-priority ${r.sellP}/100">
          <div class="sell-meter-bar"><span class="fill ${tone}" style="width:${r.sellP}%"></span></div>
          <span class="sell-p">${r.sellP}</span>
        </div>
      </div>`;
    })
    .join("");

  return `<div class="sell-board">
    <h2>🔻 Best to sell first</h2>
    <p class="sell-sub">Ranked by a blend of bearish signal, over-concentration, and money flowing out (accumulation/distribution). Higher = consider selling sooner. Tap a row to open the full analysis. <b>Not financial advice.</b></p>
    ${items}
  </div>`;
}

function wireDoctorRowClicks(container) {
  container.querySelectorAll(".sell-row").forEach((el) => {
    el.onclick = () => {
      $("symbol").value = el.dataset.sym;
      switchTab("analyze");
      run();
    };
  });
}

function diversificationNote(types, topWeight, divScore) {
  const parts = [];
  const mix = Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, w]) => `${t} ${(w * 100).toFixed(0)}%`);
  if (mix.length) parts.push("Mix: " + mix.join(" · ") + ".");
  if (topWeight > 0.25) parts.push(`Your largest position is ${(topWeight * 100).toFixed(0)}% of the book — that's concentrated; consider trimming toward ≤20%.`);
  if (divScore < 40) parts.push("Overall this portfolio is concentrated — spreading across more positions/asset types would lower single-name risk.");
  else if (divScore >= 60) parts.push("Diversification looks reasonable.");
  parts.push("Recommendations blend each holding's technical signal with its weight — not financial advice.");
  return parts.join(" ");
}

function renderIdeas(ideas) {
  const el = $("doctorIdeas");
  if (!ideas.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <h2>💡 Ideas to consider adding</h2>
    <p class="section-intro">Quality, liquid names you don't already hold that currently show a constructive signal. Click to analyze.</p>
    <div class="wl-grid">
      ${ideas.map((it) => `<button class="wl-item" data-sym="${esc(it.symbol)}">
        <span class="wl-row"><span class="wl-sym">${esc(it.symbol)}</span>
        <span class="wl-price buy">+${it.score}</span></span>
        <span class="wl-note">${esc(it.action)}</span>
      </button>`).join("")}
    </div>`;
  el.querySelectorAll(".wl-item").forEach((b) => {
    b.onclick = () => {
      $("symbol").value = b.dataset.sym;
      switchTab("analyze");
      run();
    };
  });
}

// ---------------- Stock Ranker ----------------
const RANKER_CACHE = "signaldesk_ranker_v3";
const RANKER_CUSTOM = "signaldesk_ranker_custom";
let rankerRows = [];
let rankerSort = { key: "overall", dir: -1 };
let rankerBuilding = false;
const rankerFilters = { grade: 0, signal: "any", value: "any", sector: "" };

function getCustomTickers() {
  try {
    return JSON.parse(localStorage.getItem(RANKER_CUSTOM)) || [];
  } catch {
    return [];
  }
}
function setCustomTickers(list) {
  try {
    localStorage.setItem(RANKER_CUSTOM, JSON.stringify([...new Set(list)]));
  } catch {
    /* ignore */
  }
}
function getUniverse() {
  return [...new Set([...getCustomTickers(), ...RANKER_DEFAULT])];
}

function readRankerCache() {
  try {
    return JSON.parse(localStorage.getItem(RANKER_CACHE));
  } catch {
    return null;
  }
}
function writeRankerCache(rows) {
  try {
    localStorage.setItem(RANKER_CACHE, JSON.stringify({ ts: Date.now(), rows, universe: getUniverse().sort() }));
  } catch {
    /* ignore */
  }
}

async function renderRanker(force) {
  renderUniverseChips();
  const content = $("rankerContent");
  if (!getFmpKey()) {
    content.innerHTML = rankerNoKeyMsg();
    $("rankerAsOf").textContent = "";
    return;
  }
  const cache = readRankerCache();
  const sameUniverse = cache && JSON.stringify(cache.universe) === JSON.stringify(getUniverse().sort());
  if (cache && cache.rows && cache.rows.length && sameUniverse && !force && Date.now() - cache.ts < 12 * 3600 * 1000) {
    rankerRows = cache.rows;
    $("rankerAsOf").textContent = "as of " + new Date(cache.ts).toLocaleString();
    buildSectorFilter();
    renderRankerTable();
    return;
  }
  await buildRanker();
}

// Downsample an array to ~n points for a compact sparkline.
function downsample(arr, n) {
  if (!arr || arr.length <= n) return arr || [];
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

async function buildRanker() {
  if (rankerBuilding) return;
  rankerBuilding = true;
  const universe = getUniverse();
  const content = $("rankerContent");
  content.innerHTML = `<p class="status loading" id="rankerProgress">Scoring ${universe.length} companies… first run pulls fundamentals + signals (cached 12h).</p>`;

  // 1) batched company profiles (cheap)
  const profiles = await fetchProfiles(universe);
  // 2) per-stock ratios (FMP) + candles (keyless Yahoo → signal + price trend)
  let done = 0;
  const rows = (
    await mapLimit(universe, 5, async (sym) => {
      const pf = profiles[sym] || null;
      let ratios = null;
      let tech = null;
      let priceTrend = null;
      let price = pf ? pf.price : null;
      try {
        ratios = await fetchRatiosTTM(sym);
      } catch {
        /* skip */
      }
      try {
        const c = await fetchCandles(sym, "1d", 400);
        tech = analyze(c).score;
        const closes = c.slice(-40).map((x) => x.close);
        priceTrend = downsample(closes, 14);
        if (price == null && closes.length) price = closes[closes.length - 1];
      } catch {
        /* no signal */
      }
      done++;
      const pr = document.getElementById("rankerProgress");
      if (pr) pr.textContent = `Scoring… ${done}/${universe.length}`;
      if (!pf && !ratios) return null;
      const f = {
        symbol: sym,
        name: pf ? pf.name : sym,
        sector: pf ? pf.sector : null,
        marketCap: pf ? pf.marketCap : null,
        beta: pf ? pf.beta : null,
        price,
        grossMarginPct: ratios ? ratios.grossMarginPct : null,
        netMarginPct: ratios ? ratios.netMarginPct : null,
        pe: ratios ? ratios.pe : null,
        eps: ratios && ratios.pe && price ? price / ratios.pe : null,
        debtToEquity: ratios ? ratios.debtToEquity : null,
        currentRatio: ratios ? ratios.currentRatio : null,
        fcfPositive: ratios && ratios.netMarginPct != null ? ratios.netMarginPct > 0 : null,
        epsTrend: null,
      };
      const row = buildRankerRow(f, tech);
      row.priceTrend = priceTrend;
      return row;
    })
  ).filter(Boolean);
  rows.sort((a, b) => (b.overall || 0) - (a.overall || 0));
  rankerRows = rows;
  writeRankerCache(rows);
  $("rankerAsOf").textContent = "as of " + new Date().toLocaleString();
  rankerBuilding = false;
  if (!rows.length) {
    content.innerHTML = `<p class="section-intro">No data returned — your API key may be rate-limited (the free tier is ~250 calls/day). Try again later, or trim the universe.</p>`;
    return;
  }
  buildSectorFilter();
  renderRankerTable();
}

function buildSectorFilter() {
  const sel = $("fltSector");
  const cur = sel.value;
  const sectors = [...new Set(rankerRows.map((r) => r.sector).filter(Boolean))].sort();
  sel.innerHTML = `<option value="">Sector: all</option>` + sectors.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  sel.value = sectors.includes(cur) ? cur : "";
}

function signalChip(score) {
  if (score == null) return `<span class="sig sig-na">—</span>`;
  if (score >= 45) return `<span class="sig sig-sb">STRONG BUY</span>`;
  if (score >= 18) return `<span class="sig sig-b">BUY</span>`;
  if (score > -18) return `<span class="sig sig-h">HOLD</span>`;
  if (score > -45) return `<span class="sig sig-s">SELL</span>`;
  return `<span class="sig sig-ss">STRONG SELL</span>`;
}
function pillarCell(v) {
  if (v == null) return `<td class="rk-na">—</td>`;
  const tone = v >= 66 ? "buy" : v >= 45 ? "hold" : "sell";
  return `<td class="rk-pill ${tone}">${v}</td>`;
}
function sparkline(vals) {
  if (!vals || vals.length < 2) return "";
  const w = 62;
  const h = 20;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const up = vals[vals.length - 1] >= vals[0];
  const color = up ? "#16c784" : "#e23744";
  const pts = vals
    .map((v, i) => `${((i / (vals.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 1 - ((v - min) / range) * (h - 2)).toFixed(1)}`)
    .join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}
function fairValueCell(r) {
  if (r.fairPrice == null || r.price == null) return `<td class="rk-na">—</td>`;
  const diff = ((r.price - r.fairPrice) / r.fairPrice) * 100;
  const tone = diff <= -5 ? "buy" : diff >= 15 ? "sell" : "";
  const label = diff <= -10 ? "undervalued" : diff >= 15 ? "pricey" : "fair";
  return `<td class="rk-fair ${tone}"><b>$${fmt(r.fairPrice)}</b><span>${label} (${diff >= 0 ? "+" : ""}${diff.toFixed(0)}%)</span></td>`;
}

function passesFilters(r) {
  if (rankerFilters.grade && (r.overall == null || r.overall < rankerFilters.grade)) return false;
  if (rankerFilters.sector && r.sector !== rankerFilters.sector) return false;
  const s = r.techScore;
  if (rankerFilters.signal === "buy" && !(s != null && s >= 18)) return false;
  if (rankerFilters.signal === "strong" && !(s != null && s >= 45)) return false;
  if (rankerFilters.signal === "notsell" && !(s != null && s > -18)) return false;
  if (rankerFilters.value !== "any") {
    if (r.fairPrice == null || r.price == null) return false;
    const diff = (r.price - r.fairPrice) / r.fairPrice;
    if (rankerFilters.value === "under" && !(diff <= -0.1)) return false;
    if (rankerFilters.value === "fairbetter" && !(diff <= 0.15)) return false;
  }
  return true;
}

function renderRankerTable() {
  const content = $("rankerContent");
  const q = ($("rankerSearch").value || "").trim().toLowerCase();
  let rows = rankerRows.filter(passesFilters);
  if (q) rows = rows.filter((r) => `${r.symbol} ${r.name || ""} ${r.sector || ""}`.toLowerCase().includes(q));
  const { key, dir } = rankerSort;
  const getv = (r) =>
    key === "symbol" || key === "sector"
      ? (r[key] || "").toString().toLowerCase()
      : key.startsWith("pillar.")
      ? r.pillars[key.split(".")[1]] ?? -1
      : key === "signal"
      ? r.techScore ?? -999
      : key === "fair"
      ? r.fairPrice != null && r.price != null ? (r.price - r.fairPrice) / r.fairPrice : 999
      : r[key] ?? -1;
  rows = rows.slice().sort((a, b) => {
    const va = getv(a);
    const vb = getv(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return 0;
  });
  const arrow = (k) => (rankerSort.key === k ? (dir === -1 ? " ▼" : " ▲") : "");
  const th = (k, label) => `<th class="sortable" data-k="${k}">${label}${arrow(k)}</th>`;
  const head = `<tr>
    <th>#</th>
    ${th("symbol", "Ticker")}
    ${th("overall", "Score")}
    <th>30d</th>
    ${th("sector", "Sector")}
    ${th("marketCap", "Mkt Cap")}
    ${th("pillar.profit", "Profit")}
    ${th("pillar.moat", "Moat")}
    ${th("pillar.survival", "Survival")}
    ${th("pillar.stability", "Stable")}
    ${th("pillar.value", "Value")}
    ${th("signal", "Signal")}
    ${th("fair", "Fair value")}
  </tr>`;
  const body = rows
    .map((r, i) => {
      const gtone = r.overall >= 66 ? "buy" : r.overall >= 50 ? "" : "sell";
      return `<tr class="rk-row" data-sym="${esc(r.symbol)}">
      <td class="rk-rank">${i + 1}</td>
      <td class="rk-tk"><b>${esc(r.symbol)}</b><span>${esc((r.name || "").slice(0, 22))}</span></td>
      <td class="rk-score"><span class="rk-grade ${gtone}">${r.grade}</span> ${r.overall ?? "—"}</td>
      <td class="rk-spark">${sparkline(r.priceTrend)}</td>
      <td class="rk-sector">${esc(r.sector || "—")}</td>
      <td>${r.marketCap != null ? fmt(r.marketCap, { compact: true }) : "—"}</td>
      ${pillarCell(r.pillars.profit)}
      ${pillarCell(r.pillars.moat)}
      ${pillarCell(r.pillars.survival)}
      ${pillarCell(r.pillars.stability)}
      ${pillarCell(r.pillars.value)}
      <td>${signalChip(r.techScore)}</td>
      ${fairValueCell(r)}
    </tr>`;
    })
    .join("");
  const count = `<div class="ranker-count">${rows.length} of ${rankerRows.length} shown</div>`;
  content.innerHTML =
    count +
    `<div class="table-wrap"><table class="pf-table ranker-table"><thead>${head}</thead><tbody>${body || `<tr><td colspan="13" class="empty">No stocks match these filters.</td></tr>`}</tbody></table></div>
    <p class="val-source">Quality pillars from fundamentals; Moat is a margin+scale proxy (the single-stock view does true peer ranking). Signal is our live technical read; 30d is a price sparkline. Fair value uses a growth-adjusted reasonable P/E. Educational — not advice.</p>`;
  content.querySelectorAll("th.sortable").forEach((t) => {
    t.onclick = () => {
      const k = t.dataset.k;
      if (rankerSort.key === k) rankerSort.dir *= -1;
      else rankerSort = { key: k, dir: k === "symbol" || k === "sector" ? 1 : -1 };
      renderRankerTable();
    };
  });
  content.querySelectorAll(".rk-row").forEach((row) => {
    row.onclick = () => {
      $("symbol").value = row.dataset.sym;
      switchTab("analyze");
      run();
    };
  });
}

function renderUniverseChips() {
  const el = $("uniChips");
  if (!el) return;
  const custom = getCustomTickers();
  el.innerHTML =
    `<span class="uni-count">${getUniverse().length} tickers</span>` +
    custom.map((t) => `<span class="uni-chip" data-t="${esc(t)}">${esc(t)} <b>✕</b></span>`).join("");
  el.querySelectorAll(".uni-chip").forEach((chip) => {
    chip.onclick = () => {
      setCustomTickers(getCustomTickers().filter((x) => x !== chip.dataset.t));
      renderRanker(true);
    };
  });
}

function rankerNoKeyMsg() {
  return `<div class="val-empty">
    <p><b>The Stock Ranker needs a fundamentals data source.</b> Add a <b>free</b> Financial Modeling Prep API key in
    the <b>☰ Account</b> menu → Fundamentals data (takes ~30 seconds).
    Get one at <a href="https://site.financialmodelingprep.com/developer/docs" target="_blank" rel="noopener">financialmodelingprep.com</a>.</p>
    <p>Then reopen this tab to rank ${RANKER_DEFAULT.length}+ large-cap stocks by Profit, Moat, Survival, Stability &amp; Value — with our live Signal and Fair-Value price on every row.</p>
  </div>`;
}
// ---------------- Tabs ----------------
function switchTab(name) {
  const tier = currentTier();
  if (name === "screener" && !tier.screener) return openPricing();
  if (name === "paper" && !tier.paperTrading) return openPricing();
  if (name === "doctor" && !tier.doctor) return openPricing();
  if (name === "ranker" && !tier.doctor) return openPricing();
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tabview").forEach((v) => v.classList.add("hidden"));
  $("tab-" + name).classList.remove("hidden");
  if (name === "screener") renderScreener();
  if (name === "paper") renderPaper();
  if (name === "ranker") renderRanker(false);
}

function refreshTabLocks() {
  const tier = currentTier();
  $("tabScreenerBtn").textContent = (tier.screener ? "💰" : "🔒") + " Income & Growth";
  $("tabPaperBtn").textContent = (tier.paperTrading ? "🎮" : "🔒") + " Paper Trading";
  $("tabDoctorBtn").textContent = (tier.doctor ? "🩺" : "🔒") + " Portfolio Doctor";
  $("tabRankerBtn").textContent = (tier.doctor ? "🏆" : "🔒") + " Stock Ranker";
  const active = document.querySelector(".tab.active");
  if (active) {
    const t = active.dataset.tab;
    if (
      (t === "screener" && !tier.screener) ||
      (t === "paper" && !tier.paperTrading) ||
      (t === "doctor" && !tier.doctor) ||
      (t === "ranker" && !tier.doctor)
    )
      switchTab("analyze");
  }
}

// ---------------- Symbol search (autocomplete) ----------------
let searchTimer = null;
function onSymbolInput(e) {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 2) return hideSearch();
  searchTimer = setTimeout(async () => {
    let results = [];
    try {
      results = await searchSymbols(q);
    } catch {
      /* ignore */
    }
    renderSearch(results);
  }, 250);
}
function renderSearch(results) {
  const box = $("searchResults");
  box.innerHTML = "";
  if (!results.length) return hideSearch();
  results.slice(0, 8).forEach((r) => {
    const d = document.createElement("div");
    d.className = "search-item";
    const sym = document.createElement("span");
    sym.className = "si-sym";
    sym.textContent = r.symbol;
    const nm = document.createElement("span");
    nm.className = "si-name";
    nm.textContent = r.name;
    const ty = document.createElement("span");
    ty.className = "si-type";
    ty.textContent = r.type || "";
    d.append(sym, nm, ty);
    d.onclick = () => {
      $("symbol").value = r.symbol;
      hideSearch();
      run();
    };
    box.appendChild(d);
  });
  box.classList.remove("hidden");
}
function hideSearch() {
  $("searchResults").classList.add("hidden");
}

// ---------------- Income & Growth screener ----------------
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
let screenerPriced = false;
function renderScreener() {
  const el = $("screenerContent");
  el.innerHTML = WATCHLISTS.map(
    (w) => `
    <div class="wl">
      <div class="wl-head"><h3>${esc(w.title)}</h3><span>${esc(w.blurb)}</span></div>
      <div class="wl-grid">
        ${w.items
          .map(
            (it) => `<button class="wl-item" data-sym="${esc(it.symbol)}">
            <span class="wl-row"><span class="wl-sym">${esc(it.symbol)}</span>
              <span class="wl-price" data-sym="${esc(it.symbol)}">…</span></span>
            <span class="wl-name">${esc(it.name)}</span>
            <span class="wl-note">${esc(it.note || "")}</span>
          </button>`
          )
          .join("")}
      </div>
    </div>`
  ).join("");
  el.querySelectorAll(".wl-item").forEach((b) => {
    b.onclick = () => {
      $("symbol").value = b.dataset.sym;
      switchTab("analyze");
      run();
    };
  });
  if (!screenerPriced) {
    screenerPriced = true;
    loadScreenerPrices();
  }
}

async function loadScreenerPrices() {
  const symbols = [...new Set(WATCHLISTS.flatMap((w) => w.items.map((i) => i.symbol)))];
  await mapLimit(symbols, 5, async (sym) => {
    let q;
    try {
      q = await fetchQuote(sym);
    } catch {
      document.querySelectorAll(`.wl-price[data-sym="${cssEsc(sym)}"]`).forEach((e) => (e.textContent = ""));
      return;
    }
    const cls = q.changePct >= 0 ? "buy" : "sell";
    const txt = `$${fmt(q.price)} ${q.changePct >= 0 ? "▲" : "▼"}${Math.abs(q.changePct).toFixed(1)}%`;
    document.querySelectorAll(`.wl-price[data-sym="${cssEsc(sym)}"]`).forEach((e) => {
      e.textContent = txt;
      e.className = "wl-price " + cls;
    });
  });
}
function cssEsc(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

// ---------------- Paper trading ----------------
function pfEmail() {
  const u = auth.getUser();
  return u ? u.email : "guest";
}
function trimQty(q) {
  return Number(q).toLocaleString(undefined, { maximumFractionDigits: 4 });
}
async function renderPaper() {
  const email = pfEmail();
  const p = portfolio.load(email);
  const syms = Object.keys(p.positions);
  const prices = {};
  await Promise.all(
    syms.map(async (s) => {
      try {
        prices[s] = (await fetchQuote(s)).price;
      } catch {
        prices[s] = null;
      }
    })
  );
  const v = portfolio.value(p, prices);
  $("pfTotal").textContent = "$" + fmt(v.total);
  $("pfCash").textContent = "$" + fmt(v.cash);
  $("pfHoldings").textContent = "$" + fmt(v.holdingsValue);
  const pnl = $("pfPnl");
  pnl.textContent =
    (v.totalPnl >= 0 ? "+$" : "-$") +
    fmt(Math.abs(v.totalPnl)) +
    ` (${v.totalPnlPct >= 0 ? "+" : ""}${v.totalPnlPct.toFixed(2)}%)`;
  pnl.className = "n " + (v.totalPnl >= 0 ? "buy" : "sell");

  // record + draw the equity curve
  const equity = portfolio.snapshot(email, v.total);
  requestAnimationFrame(() => {
    try {
      drawEquityChart(equity);
    } catch (e) {
      console.error("equity chart failed:", e);
    }
  });

  $("positionsBody").innerHTML = v.rows.length
    ? v.rows
        .map(
          (r) => `<tr>
        <td><button class="link-sym" data-sym="${esc(r.symbol)}" data-qty="${r.qty}">${esc(r.symbol)}</button></td>
        <td>${trimQty(r.qty)}</td>
        <td>$${fmt(r.avgCost)}</td>
        <td>${r.price != null ? "$" + fmt(r.price) : "—"}</td>
        <td>${r.marketValue != null ? "$" + fmt(r.marketValue) : "—"}</td>
        <td class="${r.pnl >= 0 ? "buy" : "sell"}">${
            r.pnl != null
              ? (r.pnl >= 0 ? "+" : "-") + "$" + fmt(Math.abs(r.pnl)) + ` (${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(1)}%)`
              : "—"
          }</td>
        <td><button class="row-sell" data-sym="${esc(r.symbol)}" data-qty="${r.qty}">Sell all</button></td></tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty">No positions yet — buy something above.</td></tr>`;
  // wire per-row actions
  $("positionsBody").querySelectorAll(".row-sell").forEach((btn) => {
    btn.onclick = () => sellPosition(btn.dataset.sym, parseFloat(btn.dataset.qty));
  });
  $("positionsBody").querySelectorAll(".link-sym").forEach((btn) => {
    btn.onclick = () => loadIntoOrder(btn.dataset.sym, parseFloat(btn.dataset.qty));
  });

  $("historyBody").innerHTML = p.history.length
    ? p.history
        .map(
          (h) => `<tr>
        <td>${new Date(h.ts).toLocaleString()}</td>
        <td class="${h.side === "buy" ? "buy" : "sell"}">${h.side.toUpperCase()}</td>
        <td>${esc(h.symbol)}</td><td>${trimQty(h.qty)}</td><td>$${fmt(h.price)}</td><td>$${fmt(h.value)}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="empty">No trades yet.</td></tr>`;
}

function setPriceDisplay(sym, price) {
  const el = $("tradePrice");
  el.dataset.sym = sym || "";
  el.dataset.price = price != null ? price : "";
  el.textContent = price != null ? "$" + fmt(price) : sym ? "n/a" : "—";
}
async function doQuote() {
  const sym = $("tradeSymbol").value.trim().toUpperCase();
  if (!sym) {
    setPriceDisplay("", null);
    return null;
  }
  $("tradePrice").textContent = "…";
  try {
    const q = await fetchQuote(sym);
    setPriceDisplay(sym, q.price);
    return q.price;
  } catch {
    setPriceDisplay(sym, null);
    return null;
  }
}

// Always fetch a fresh live price for the exact symbol being ordered — never
// reuse a cached price from a different symbol. Returns the price or null.
async function livePriceFor(sym) {
  try {
    const q = await fetchQuote(sym);
    setPriceDisplay(sym, q.price);
    return q.price;
  } catch {
    setPriceDisplay(sym, null);
    return null;
  }
}

async function doTrade(side) {
  const email = pfEmail();
  const sym = $("tradeSymbol").value.trim().toUpperCase();
  const qty = parseFloat($("tradeQty").value);
  const msg = $("tradeMsg");
  if (!sym) {
    msg.textContent = "Enter a symbol first.";
    msg.className = "trade-msg err";
    return;
  }
  if (!(qty > 0)) {
    msg.textContent = "Enter a quantity greater than zero.";
    msg.className = "trade-msg err";
    return;
  }
  msg.textContent = `Getting live price for ${sym}…`;
  msg.className = "trade-msg";
  const price = await livePriceFor(sym); // fresh price for THIS symbol
  if (!price) {
    msg.textContent = `Couldn't get a live price for ${sym}. Check the symbol and try again.`;
    msg.className = "trade-msg err";
    return;
  }
  const res = portfolio.trade(email, side, sym, qty, price);
  if (res.error) {
    msg.textContent = res.error;
    msg.className = "trade-msg err";
  } else {
    msg.textContent = `${side === "buy" ? "Bought" : "Sold"} ${trimQty(qty)} ${sym} @ $${fmt(price)}.`;
    msg.className = "trade-msg ok";
    renderPaper();
  }
}

// Sell an entire position straight from the positions table (fresh live price).
async function sellPosition(sym, qty) {
  const msg = $("tradeMsg");
  msg.textContent = `Selling ${trimQty(qty)} ${sym} at live price…`;
  msg.className = "trade-msg";
  const price = await livePriceFor(sym);
  if (!price) {
    msg.textContent = `Couldn't get a live price for ${sym}. Try again.`;
    msg.className = "trade-msg err";
    return;
  }
  const res = portfolio.trade(pfEmail(), "sell", sym, qty, price);
  if (res.error) {
    msg.textContent = res.error;
    msg.className = "trade-msg err";
  } else {
    msg.textContent = `Sold ${trimQty(qty)} ${sym} @ $${fmt(price)}.`;
    msg.className = "trade-msg ok";
    renderPaper();
  }
}

// Load a holding into the order form (for partial sells / adjustments).
function loadIntoOrder(sym, qty) {
  $("tradeSymbol").value = sym;
  $("tradeQty").value = qty;
  doQuote();
  $("tradeSymbol").scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------------- Boot ----------------
window.addEventListener("DOMContentLoaded", () => {
  buildPresetOptions();

  $("preset").addEventListener("change", (e) => {
    if (e.target.value) {
      $("symbol").value = e.target.value;
      run();
    }
  });
  $("analyzeBtn").addEventListener("click", () => {
    hideSearch();
    run();
  });
  $("symbol").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      hideSearch();
      run();
    }
  });
  $("symbol").addEventListener("input", onSymbolInput);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-field")) hideSearch();
  });
  window.addEventListener("resize", () => {
    if (state.result) scheduleChart(state.candles, state.result.indicators);
    const paperVisible = !$("tab-paper").classList.contains("hidden");
    if (paperVisible) {
      const eq = portfolio.load(pfEmail()).equity;
      requestAnimationFrame(() => {
        try {
          drawEquityChart(eq);
        } catch {}
      });
    }
  });

  // tabs
  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab))
  );

  // chart zoom / pan
  wireChartInteractions();
  document.querySelectorAll(".zoom-group button").forEach((b) =>
    b.addEventListener("click", () => {
      const z = b.dataset.z;
      if (z === "in") chartZoom(0.8);
      else if (z === "out") chartZoom(1.25);
      else {
        resetChartView(state.candles.length);
        redrawChart();
      }
    })
  );
  // chart type toggle
  const syncChartType = () =>
    document.querySelectorAll("#chartType .ct-btn").forEach((b) => b.classList.toggle("active", b.dataset.ct === chartType));
  document.querySelectorAll("#chartType .ct-btn").forEach((b) =>
    b.addEventListener("click", () => {
      chartType = b.dataset.ct;
      try { localStorage.setItem("signaldesk_charttype", chartType); } catch {}
      syncChartType();
      redrawChart();
    })
  );
  syncChartType();

  // paper trading controls
  $("quoteBtn").addEventListener("click", doQuote);
  $("tradeBuy").addEventListener("click", () => doTrade("buy"));
  $("tradeSell").addEventListener("click", () => doTrade("sell"));
  $("refreshPaper").addEventListener("click", renderPaper);
  $("resetPaper").addEventListener("click", () => {
    if (confirm("Reset your paper portfolio back to $100,000 cash? This clears all positions and history.")) {
      portfolio.reset(pfEmail());
      renderPaper();
    }
  });
  $("tradeSymbol").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doQuote();
  });
  // clear any stale price the moment the symbol changes (prevents mis-priced orders)
  $("tradeSymbol").addEventListener("input", () => setPriceDisplay("", null));

  // portfolio doctor
  $("runDoctor").addEventListener("click", runDoctor);
  $("csvFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $("holdingsInput").value = String(reader.result || "");
    };
    reader.readAsText(file);
  });
  $("imgFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleImageUpload(file);
    e.target.value = ""; // allow re-uploading the same file
  });
  $("loadSampleBtn").addEventListener("click", () => {
    $("holdingsInput").value = "AAPL 60\nNVDA 40\nMSFT 30\nVOO 25\nSCHD 200\nTSLA 50\nBTC-USD 0.4";
    try { localStorage.setItem("signaldesk_doctor_holdings", $("holdingsInput").value); } catch {}
  });
  // remember the holdings you typed
  try {
    const savedHoldings = localStorage.getItem("signaldesk_doctor_holdings");
    if (savedHoldings) $("holdingsInput").value = savedHoldings;
  } catch {}
  $("holdingsInput").addEventListener("input", () => {
    try { localStorage.setItem("signaldesk_doctor_holdings", $("holdingsInput").value); } catch {}
  });
  // export
  $("dlPdf").addEventListener("click", exportDoctorPdf);
  $("dlPng").addEventListener("click", exportDoctorPng);

  // stock ranker
  $("rankerSearch").addEventListener("input", () => {
    if (rankerRows.length) renderRankerTable();
  });
  $("rankerRefresh").addEventListener("click", () => {
    if (getFmpKey()) buildRanker();
  });
  const onFilter = () => {
    rankerFilters.grade = +$("fltGrade").value;
    rankerFilters.signal = $("fltSignal").value;
    rankerFilters.value = $("fltValue").value;
    rankerFilters.sector = $("fltSector").value;
    if (rankerRows.length) renderRankerTable();
  };
  ["fltGrade", "fltSignal", "fltValue", "fltSector"].forEach((id) => $(id).addEventListener("change", onFilter));
  const addTickers = () => {
    const raw = $("uniAdd").value.toUpperCase().split(/[,\s]+/).map((t) => t.replace(/[^A-Z0-9.\-=^]/g, "")).filter(Boolean);
    if (!raw.length) return;
    setCustomTickers([...getCustomTickers(), ...raw]);
    $("uniAdd").value = "";
    renderRanker(true);
  };
  $("uniAddBtn").addEventListener("click", addTickers);
  $("uniAdd").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTickers();
  });

  // side menu
  const openMenu = () => $("sideMenu").classList.remove("hidden");
  const closeMenu = () => $("sideMenu").classList.add("hidden");
  $("menuBtn").addEventListener("click", () => {
    renderUserBar();
    $("fmpKeyInput").value = getFmpKey();
    $("fmpKeyMsg").textContent = getFmpKey() ? "Key saved — fundamentals enabled." : "";
    openMenu();
  });
  $("saveKeyBtn").addEventListener("click", () => {
    setFmpKey($("fmpKeyInput").value);
    const msg = $("fmpKeyMsg");
    msg.className = "fund-key-msg";
    msg.textContent = getFmpKey() ? "✓ Saved. Hit Test to verify, then re-run an analysis." : "Key cleared.";
    if (state.result) run();
  });
  $("testKeyBtn").addEventListener("click", async () => {
    const msg = $("fmpKeyMsg");
    setFmpKey($("fmpKeyInput").value); // test whatever is in the box
    msg.className = "fund-key-msg";
    msg.textContent = "Testing…";
    const res = await testFmpKey();
    msg.className = "fund-key-msg " + (res.ok ? "ok" : "err");
    msg.textContent = (res.ok ? "✓ " : "✗ ") + res.msg;
  });
  $("menuClose").addEventListener("click", closeMenu);
  $("menuBackdrop").addEventListener("click", closeMenu);
  $("loginBtn").addEventListener("click", () => {
    closeMenu();
    setAuthMode("signup");
    showAuth();
  });

  // account buttons
  $("upgradeBtn").addEventListener("click", () => {
    closeMenu();
    openPricing();
  });
  $("logoutBtn").addEventListener("click", () => {
    auth.logout();
    auth.setViewAs(null);
    applyTier();
    closeMenu();
    run();
  });
  $("viewAsSel").addEventListener("change", (e) => {
    auth.setViewAs(e.target.value);
    applyTier();
    if (state.result) run();
  });
  $("closePricing").addEventListener("click", closePricing);
  $("pricingModal").addEventListener("click", (e) => {
    if (e.target.id === "pricingModal") closePricing();
  });

  // auth form (optional)
  $("authForm").addEventListener("submit", submitAuth);
  $("authClose").addEventListener("click", hideAuth);
  $("authSkip").addEventListener("click", hideAuth);
  setAuthMode("signup");

  // expose a couple handlers for inline onclicks
  window.__openPricing = openPricing;
  window.__choosePlan = choosePlan;

  // welcome / how-it-works guide
  const WELCOME_KEY = "signaldesk_seen_welcome";
  const openWelcome = () => $("welcomeModal").classList.remove("hidden");
  const closeWelcome = () => $("welcomeModal").classList.add("hidden");
  $("helpBtn").addEventListener("click", () => {
    $("welcomeDontShow").checked = false; // reopening manually shouldn't force-hide it
    openWelcome();
  });
  $("closeWelcome").addEventListener("click", closeWelcome);
  $("welcomeStart").addEventListener("click", () => {
    if ($("welcomeDontShow").checked) {
      try { localStorage.setItem(WELCOME_KEY, "1"); } catch {}
    }
    closeWelcome();
  });
  $("welcomeModal").addEventListener("click", (e) => {
    if (e.target.id === "welcomeModal") closeWelcome();
  });
  // show automatically on first visit
  try {
    if (!localStorage.getItem(WELCOME_KEY)) openWelcome();
  } catch {}

  // Market regime (market-wide context) — loads independently, cached 30 min.
  const regimeRefresh = $("regimeRefresh");
  if (regimeRefresh) regimeRefresh.addEventListener("click", () => loadMarketRegime(true));

  // No login gate in dev mode — go straight into the app with full access.
  hideAuth();
  applyTier();
  run();
  initNews();
  loadMarketRegime();
});
