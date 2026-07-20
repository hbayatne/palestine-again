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
  getFmpKey,
  setFmpKey,
} from "./data.js";
import { buildScorecard, scoreCompetition, INDUSTRY_PEERS } from "./valuation.js";
import { TIERS, TIER_ORDER } from "./tiers.js";
import * as auth from "./auth.js";
import { fetchNews } from "./news.js";
import { WATCHLISTS } from "./watchlists.js";
import * as portfolio from "./portfolio.js";

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
const ALL_PRESETS = PRESET_GROUPS.flatMap((g) => g.items);

const TF_LABELS = { "15m": "15 min", "1h": "1 hour", "4h": "4 hour", "1d": "Daily", "1w": "Weekly" };

const $ = (id) => document.getElementById(id);
const state = { candles: [], result: null, fundamentals: null };

// DEV MODE: while building, everyone gets full access and login is optional.
// The tier machinery stays intact — flip this to false to enforce real tiers.
const DEV_FULL_ACCESS = true;

function currentTier() {
  const u = auth.getUser();
  if (u) return TIERS[auth.effectiveTierId()] || TIERS.free;
  // not signed in: dev mode unlocks everything (respecting any "preview tier" pick)
  if (DEV_FULL_ACCESS) return TIERS[auth.getViewAs() || "pro"] || TIERS.pro;
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
  if (!f || (f.netMarginPct == null && f.grossMarginPct == null && f.pe == null)) {
    $("valueContent").innerHTML = noFundamentalsMsg();
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

function noFundamentalsMsg() {
  const hasKey = !!getFmpKey();
  return `<div class="val-empty">
    <p><b>Fundamentals unavailable for this symbol.</b> ${
      hasKey
        ? "Your data key didn't return figures for this ticker (it may be an ETF/ADR/non-US listing)."
        : "Quality & value scoring needs a fundamentals data source."
    }</p>
    ${
      hasKey
        ? ""
        : `<p>Add a <b>free</b> Financial Modeling Prep API key (takes ~30 seconds) in the <b>☰ Account</b> menu → Fundamentals data. Get one at
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

  scheduleChart(state.candles, r.indicators);
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
  build();
  const seconds = Math.max(30, items.length * 5);
  track.style.animationDuration = seconds + "s";
  ticker.classList.remove("hidden");
}

function upsell(msg) {
  return `<div class="upsell" onclick="window.__openPricing()">🔒 ${msg}<br><span class="upsell-cta">Upgrade →</span></div>`;
}

function chip(label, value, tone = "") {
  return `<div class="metric ${tone}"><span class="ml">${label}</span><span class="mv">${value ?? "—"}</span></div>`;
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

  const view = candles.slice(-140);
  const offset = candles.length - view.length;
  const padL = 8;
  const padR = 58;
  const priceH = cssH * 0.72;
  const rsiTop = priceH + 24;
  const rsiH = cssH - rsiTop - 6;

  const highs = view.map((c) => c.high);
  const lows = view.map((c) => c.low);
  let max = Math.max(...highs);
  let min = Math.min(...lows);
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

  const cw = Math.max(1.5, ((cssW - padL - padR) / view.length) * 0.62);
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

let doctorBusy = false;
async function runDoctor() {
  if (doctorBusy) return;
  const text = $("holdingsInput").value;
  const holdings = parseHoldings(text);
  const out = $("doctorResults");
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
      return { ...h, price, value, score: res.score, action: res.action, ok: true };
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
    return { ...r, weight, type: assetType(r.symbol), rec: recommend(r.score, weight) };
  });
  analyzed.sort((a, b) => (b.weight || 0) - (a.weight || 0));

  renderDoctor(analyzed, totalValue);

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

  $("doctorResults").innerHTML = summary + table;
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

// ---------------- Tabs ----------------
function switchTab(name) {
  const tier = currentTier();
  if (name === "screener" && !tier.screener) return openPricing();
  if (name === "paper" && !tier.paperTrading) return openPricing();
  if (name === "doctor" && !tier.doctor) return openPricing();
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tabview").forEach((v) => v.classList.add("hidden"));
  $("tab-" + name).classList.remove("hidden");
  if (name === "screener") renderScreener();
  if (name === "paper") renderPaper();
}

function refreshTabLocks() {
  const tier = currentTier();
  $("tabScreenerBtn").textContent = (tier.screener ? "💰" : "🔒") + " Income & Growth";
  $("tabPaperBtn").textContent = (tier.paperTrading ? "🎮" : "🔒") + " Paper Trading";
  $("tabDoctorBtn").textContent = (tier.doctor ? "🩺" : "🔒") + " Portfolio Doctor";
  const active = document.querySelector(".tab.active");
  if (active) {
    const t = active.dataset.tab;
    if (
      (t === "screener" && !tier.screener) ||
      (t === "paper" && !tier.paperTrading) ||
      (t === "doctor" && !tier.doctor)
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
  $("loadSampleBtn").addEventListener("click", () => {
    $("holdingsInput").value = "AAPL 60\nNVDA 40\nMSFT 30\nVOO 25\nSCHD 200\nTSLA 50\nBTC-USD 0.4";
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
    $("fmpKeyMsg").textContent = getFmpKey()
      ? "✓ Saved. Fundamentals enabled — re-run an analysis to see scores."
      : "Key cleared.";
    if (state.result) run();
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

  // No login gate in dev mode — go straight into the app with full access.
  hideAuth();
  applyTier();
  run();
  initNews();
});
