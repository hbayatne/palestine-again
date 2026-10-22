// backend.js — thin client for the SignalDesk backend (server/).
//
// The app is static and the backend is deployed separately, so its URL isn't
// known at build time. The user pastes it once (☰ Account → Backend API URL);
// it's stored in localStorage. With no URL set, backend-powered features simply
// stay hidden — the rest of the app is unaffected.
const API_URL_STORE = "signaldesk_api_url";

export function getApiBase() {
  try {
    return (localStorage.getItem(API_URL_STORE) || "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function setApiBase(url) {
  try {
    const v = (url || "").trim().replace(/\/+$/, "");
    if (v) localStorage.setItem(API_URL_STORE, v);
    else localStorage.removeItem(API_URL_STORE);
  } catch {
    /* ignore */
  }
}

async function apiGet(path, ms = 7000) {
  const base = getApiBase();
  if (!base) return { configured: false };
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${base}${path}`, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return { configured: true, error: `HTTP ${res.status}` };
    return { configured: true, data: await res.json() };
  } catch (e) {
    return { configured: true, error: e.message || "network error" };
  } finally {
    clearTimeout(id);
  }
}

// Quick liveness check for the "Test" button in the menu.
export async function pingBackend() {
  const r = await apiGet("/health", 6000);
  if (!r.configured) return { ok: false, msg: "No URL set." };
  if (r.error) return { ok: false, msg: r.error };
  return { ok: !!(r.data && r.data.ok), msg: r.data && r.data.ok ? `Reachable (${r.data.env || "ok"})` : "Unexpected response" };
}

// Congressional (STOCK Act) disclosures for one ticker.
export async function fetchCongressTicker(symbol, days = 365) {
  const r = await apiGet(`/api/congress/ticker/${encodeURIComponent(symbol)}?days=${days}`);
  if (!r.configured) return { configured: false };
  if (r.error) return { configured: true, error: r.error };
  return { configured: true, ticker: r.data.ticker, trades: r.data.trades || [] };
}
