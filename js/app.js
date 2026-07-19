// app.js — UI controller: auth gate -> tier gating -> data -> signal -> render.
import { analyze, combine, VOTER_KEYS } from "./signals.js";
import {
  fetchCandles,
  fetchFundamentals,
  scoreFundamentals,
  syntheticCandles,
  looksLikeCrypto,
} from "./data.js";
import { TIERS, TIER_ORDER } from "./tiers.js";
import * as auth from "./auth.js";
import { fetchNews } from "./news.js";

// Presets across asset classes. `cg` (CoinGecko id) enables crypto fundamentals.
const PRESET_GROUPS = [
  {
    group: "Crypto",
    items: [
      { symbol: "BTCUSDT", cg: "bitcoin", label: "Bitcoin" },
      { symbol: "ETHUSDT", cg: "ethereum", label: "Ethereum" },
      { symbol: "SOLUSDT", cg: "solana", label: "Solana" },
      { symbol: "XRPUSDT", cg: "ripple", label: "XRP" },
      { symbol: "DOGEUSDT", cg: "dogecoin", label: "Dogecoin" },
    ],
  },
  {
    group: "Stocks & ETFs",
    items: [
      { symbol: "AAPL", label: "Apple" },
      { symbol: "TSLA", label: "Tesla" },
      { symbol: "NVDA", label: "Nvidia" },
      { symbol: "MSFT", label: "Microsoft" },
      { symbol: "AMZN", label: "Amazon" },
      { symbol: "SPY", label: "S&P 500 ETF" },
      { symbol: "QQQ", label: "Nasdaq 100 ETF" },
    ],
  },
  {
    group: "Forex",
    items: [
      { symbol: "EURUSD=X", label: "EUR / USD" },
      { symbol: "GBPUSD=X", label: "GBP / USD" },
      { symbol: "USDJPY=X", label: "USD / JPY" },
    ],
  },
  {
    group: "Commodities & Indices",
    items: [
      { symbol: "GC=F", label: "Gold" },
      { symbol: "CL=F", label: "Crude Oil" },
      { symbol: "^GSPC", label: "S&P 500 Index" },
    ],
  },
];
const ALL_PRESETS = PRESET_GROUPS.flatMap((g) => g.items);

const TF_LABELS = { "15m": "15 min", "1h": "1 hour", "4h": "4 hour", "1d": "Daily", "1w": "Weekly" };

const $ = (id) => document.getElementById(id);
const state = { candles: [], result: null, fundamentals: null };

function currentTier() {
  return TIERS[auth.effectiveTierId()] || TIERS.free;
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

  drawChart(state.candles, r.indicators);
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
  $("userEmail").textContent = u ? u.email : "";
  const badge = $("tierBadge");
  badge.textContent = tier.name.toUpperCase() + (u && u.owner ? " · OWNER" : "");
  badge.className = "tier-badge t-" + tier.id;

  // Owner "view as" selector
  const ownerBox = $("ownerViewAs");
  if (u && u.owner) {
    ownerBox.classList.remove("hidden");
    const sel = $("viewAsSel");
    if (sel.options.length === 0) {
      TIER_ORDER.forEach((id) => {
        const o = document.createElement("option");
        o.value = id;
        o.textContent = "View as " + TIERS[id].name;
        sel.appendChild(o);
      });
    }
    sel.value = auth.effectiveTierId();
  } else {
    ownerBox.classList.add("hidden");
  }
}

function applyTier() {
  const tier = currentTier();
  buildIntervalOptions(tier);
  renderUserBar();
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

// ---------------- Boot ----------------
window.addEventListener("DOMContentLoaded", () => {
  buildPresetOptions();

  $("preset").addEventListener("change", (e) => {
    if (e.target.value) {
      $("symbol").value = e.target.value;
      run();
    }
  });
  $("analyzeBtn").addEventListener("click", run);
  $("symbol").addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
  window.addEventListener("resize", () => {
    if (state.result) drawChart(state.candles, state.result.indicators);
  });

  // header buttons
  $("upgradeBtn").addEventListener("click", openPricing);
  $("logoutBtn").addEventListener("click", () => {
    auth.logout();
    location.reload();
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

  // auth form
  $("authForm").addEventListener("submit", submitAuth);
  setAuthMode("signup");

  // expose a couple handlers for inline onclicks
  window.__openPricing = openPricing;
  window.__choosePlan = choosePlan;

  // gate: logged in?
  if (auth.getUser()) {
    hideAuth();
    applyTier();
    run();
    initNews();
  } else {
    showAuth();
  }
});
