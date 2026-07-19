// news.js — fetches recent market headlines for the scrolling ticker.
// Crypto: CryptoCompare public news API (CORS-enabled, no key).
// Stocks: Yahoo Finance RSS headline feed via CORS proxies.
// All best-effort: any source that fails is skipped; if all fail the ticker hides.

const NEWS_PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
];

async function nfetch(url, ms = 6000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

// Which listed crypto a headline is about, from CryptoCompare's categories field.
const CRYPTO_TAGS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "ADA", "AVAX"];
function cryptoTag(categories) {
  const c = (categories || "").toUpperCase();
  for (const t of CRYPTO_TAGS) if (c.includes(t)) return t;
  return "CRYPTO";
}

// Which listed stock a headline is about, by scanning the title.
const STOCK_NAMES = [
  ["Apple", "AAPL"], ["Tesla", "TSLA"], ["Nvidia", "NVDA"], ["Microsoft", "MSFT"],
  ["Amazon", "AMZN"], ["S&P 500", "SPY"], ["Nasdaq", "QQQ"], ["Gold", "GC=F"],
  ["Oil", "CL=F"], ["Fed", "MACRO"], ["inflation", "MACRO"],
];
function stockTag(title) {
  const t = (title || "").toLowerCase();
  for (const [name, tag] of STOCK_NAMES) if (t.includes(name.toLowerCase())) return tag;
  return "MARKETS";
}

async function cryptoNews() {
  const res = await nfetch("https://min-api.cryptocompare.com/data/v2/news/?lang=EN", 6000);
  if (!res.ok) throw new Error("crypto news " + res.status);
  const j = await res.json();
  return (j.Data || []).slice(0, 14).map((n) => ({
    tag: cryptoTag(n.categories),
    title: n.title,
    url: n.url,
    source: (n.source_info && n.source_info.name) || n.source || "news",
    ts: n.published_on ? n.published_on * 1000 : Date.now(),
  }));
}

async function stockNews() {
  const feed =
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL,TSLA,NVDA,MSFT,AMZN,SPY,QQQ&region=US&lang=en-US";
  let xml = "";
  for (const wrap of NEWS_PROXIES) {
    try {
      const res = await nfetch(wrap(feed), 6000);
      if (!res.ok) continue;
      xml = await res.text();
      if (xml && xml.includes("<item")) break;
    } catch {
      /* try next proxy */
    }
  }
  if (!xml || !xml.includes("<item")) return [];
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  return [...doc.querySelectorAll("item")].slice(0, 12).map((it) => {
    const title = (it.querySelector("title") || {}).textContent || "";
    const link = (it.querySelector("link") || {}).textContent || "#";
    const dateTxt = (it.querySelector("pubDate") || {}).textContent || "";
    return { tag: stockTag(title), title, url: link, source: "Yahoo Finance", ts: Date.parse(dateTxt) || Date.now() };
  });
}

export async function fetchNews() {
  const settled = await Promise.allSettled([cryptoNews(), stockNews()]);
  const items = [];
  for (const r of settled) if (r.status === "fulfilled") items.push(...r.value);
  // newest first, dedupe by title prefix
  items.sort((a, b) => b.ts - a.ts);
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it.title) continue;
    const k = it.title.slice(0, 60).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out.slice(0, 24);
}
