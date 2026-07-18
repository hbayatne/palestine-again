// app.js — UI controller: wires inputs -> data -> signal engine -> render.
import { analyze, combine } from "./signals.js";
import {
  fetchCandles,
  fetchFundamentals,
  scoreFundamentals,
  syntheticCandles,
} from "./data.js";

// A few popular assets with their CoinGecko ids for fundamentals.
const PRESETS = [
  { symbol: "BTCUSDT", cg: "bitcoin", label: "Bitcoin" },
  { symbol: "ETHUSDT", cg: "ethereum", label: "Ethereum" },
  { symbol: "SOLUSDT", cg: "solana", label: "Solana" },
  { symbol: "BNBUSDT", cg: "binancecoin", label: "BNB" },
  { symbol: "XRPUSDT", cg: "ripple", label: "XRP" },
  { symbol: "ADAUSDT", cg: "cardano", label: "Cardano" },
  { symbol: "DOGEUSDT", cg: "dogecoin", label: "Dogecoin" },
  { symbol: "AVAXUSDT", cg: "avalanche-2", label: "Avalanche" },
];

const $ = (id) => document.getElementById(id);
const state = { candles: [], result: null, fundamentals: null };

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

async function run() {
  const symbol = $("symbol").value.trim().toUpperCase();
  const interval = $("interval").value;
  const useFund = $("useFundamentals").checked;
  setStatus("Fetching market data…", "loading");
  $("analyzeBtn").disabled = true;

  let candles;
  let source;
  try {
    candles = await fetchCandles(symbol, interval, 400);
    source = "Binance (live)";
  } catch (err) {
    candles = syntheticCandles(symbol + interval, 400);
    source = "Synthetic demo data (live fetch failed)";
    console.warn("Live fetch failed, using synthetic:", err);
  }
  state.candles = candles;

  // Fundamentals (best-effort; crypto only)
  let fundScore = null;
  state.fundamentals = null;
  if (useFund) {
    const preset = PRESETS.find((p) => p.symbol === symbol);
    if (preset) {
      try {
        const f = await fetchFundamentals(preset.cg);
        state.fundamentals = f;
        fundScore = scoreFundamentals(f);
      } catch (err) {
        console.warn("Fundamentals fetch failed:", err);
      }
    }
  }

  const result = analyze(candles);
  if (fundScore) result.blendedScore = combine(result.score, fundScore.score, 0.7);
  result.fundScore = fundScore;
  state.result = result;

  render(result, source);
  setStatus(
    `${symbol} · ${interval} · ${candles.length} candles · ${source}`,
    source.includes("Synthetic") ? "warn" : "ok"
  );
  $("analyzeBtn").disabled = false;
}

function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + (cls || "");
}

function render(r, source) {
  $("results").classList.remove("hidden");

  // Verdict card
  const finalScore = r.blendedScore != null ? r.blendedScore : r.score;
  const verdict = $("verdict");
  verdict.textContent = r.action;
  verdict.className = "verdict " + verdictClass(r.action);
  $("scoreVal").textContent = (finalScore >= 0 ? "+" : "") + finalScore;
  $("confVal").textContent = r.confidence + "%";
  $("priceVal").textContent = "$" + fmt(r.price);

  // score gauge fill (-100..100 -> 0..100%)
  const pct = (finalScore + 100) / 2;
  $("gaugeFill").style.width = pct + "%";
  $("gaugeFill").style.background = gaugeColor(finalScore);

  // Trade plan
  const plan = r.plan;
  const planEl = $("plan");
  if (plan && plan.side !== "FLAT") {
    planEl.innerHTML = `
      <div class="plan-grid">
        <div><span class="k">Side</span><span class="v ${plan.side === "LONG" ? "buy" : "sell"}">${plan.side}</span></div>
        <div><span class="k">Entry</span><span class="v">$${fmt(plan.entry)}</span></div>
        <div><span class="k">Stop-loss</span><span class="v sell">$${fmt(plan.stop)}</span></div>
        <div><span class="k">Target</span><span class="v buy">$${fmt(plan.target)}</span></div>
        <div><span class="k">Risk / trade</span><span class="v">${plan.riskPct.toFixed(2)}% (to stop)</span></div>
        <div><span class="k">Reward:Risk</span><span class="v">${plan.riskReward}:1</span></div>
      </div>
      <p class="plan-note">${plan.note}</p>`;
  } else {
    planEl.innerHTML = `<p class="plan-note">${plan ? plan.note : "No trade plan available."}</p>`;
  }

  // Snapshot chips
  const s = r.snapshot;
  $("snapshot").innerHTML = [
    chip("RSI(14)", s.rsi?.toFixed(1), rsiTone(s.rsi)),
    chip("Stoch %K", s.stochK?.toFixed(0)),
    chip("MACD hist", s.macdHist?.toFixed(4), s.macdHist > 0 ? "buy" : "sell"),
    chip("ATR(14)", fmt(s.atr)),
    chip("SMA50", fmt(s.sma50)),
    chip("SMA200", fmt(s.sma200)),
    chip("ADX", r.adx.adx?.toFixed(0), r.adx.adx > 25 ? "buy" : ""),
  ].join("");

  // Indicator breakdown table
  $("breakdown").innerHTML = r.breakdown
    .map((b) => {
      const dir = b.vote > 0.15 ? "buy" : b.vote < -0.15 ? "sell" : "neutral";
      const label = b.vote > 0.15 ? "Bullish" : b.vote < -0.15 ? "Bearish" : "Neutral";
      const barW = Math.abs(b.vote) * 50;
      const barSide = b.vote >= 0 ? "left:50%" : `right:50%`;
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

  // ADX regime note
  $("adxNote").textContent = r.adx.note || "";

  // Fundamentals
  const fundWrap = $("fundamentals");
  if (r.fundScore && state.fundamentals) {
    const f = state.fundamentals;
    fundWrap.classList.remove("hidden");
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
    $("blendNote").textContent =
      r.blendedScore != null
        ? `Final score blends technicals (70%) + fundamentals (30%) → ${r.blendedScore >= 0 ? "+" : ""}${r.blendedScore}.`
        : "";
  } else {
    fundWrap.classList.add("hidden");
    $("blendNote").textContent = "";
  }

  drawChart(state.candles, r.indicators);
}

function chip(label, value, tone = "") {
  return `<div class="metric ${tone}"><span class="ml">${label}</span><span class="mv">${
    value ?? "—"
  }</span></div>`;
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

// ---- Canvas candlestick chart with SMA overlays + RSI subpanel ----
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

  // grid + price axis
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

  const cw = Math.max(1.5, (cssW - padL - padR) / view.length * 0.62);
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

  // MA overlays
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
      if (!started) { ctx.moveTo(px, py); started = true; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  };
  overlay(ind.sma20, "#4c9aff");
  overlay(ind.sma50, "#f5a623");
  overlay(ind.sma200, "#b06cff");
  // Bollinger bands (faint)
  overlay(ind.bollinger.upper, "rgba(255,255,255,0.25)");
  overlay(ind.bollinger.lower, "rgba(255,255,255,0.25)");

  // legend
  ctx.textAlign = "left";
  const legend = [
    ["SMA20", "#4c9aff"],
    ["SMA50", "#f5a623"],
    ["SMA200", "#b06cff"],
  ];
  let lx = padL;
  legend.forEach(([t, col]) => {
    ctx.fillStyle = col;
    ctx.fillRect(lx, 10, 10, 3);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillText(t, lx + 14, 12);
    lx += 62;
  });

  // RSI subpanel
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
    if (!started) { ctx.moveTo(px, py); started = true; }
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

// wire up
window.addEventListener("DOMContentLoaded", () => {
  const sel = $("preset");
  PRESETS.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.symbol;
    o.textContent = `${p.label} (${p.symbol})`;
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => {
    $("symbol").value = sel.value;
    run();
  });
  $("analyzeBtn").addEventListener("click", run);
  $("symbol").addEventListener("keydown", (e) => {
    if (e.key === "Enter") run();
  });
  window.addEventListener("resize", () => {
    if (state.result) drawChart(state.candles, state.result.indicators);
  });
  // initial
  run();
});
