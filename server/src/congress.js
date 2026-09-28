// congress.js — Congressional (STOCK Act) trade disclosures.
//
// Why server-side: the good public datasets are large bulk files and the free
// no-key APIs cap around 100 requests/day. Fetching per-browser would blow that
// quota the moment the app has real traffic. The backend fetches once, caches in
// Postgres, and serves everyone — the correct home for this data.
//
// Sources (configurable via env): the House & Senate "Stock Watcher" public
// datasets. If a source is down or its shape drifts, that source is skipped and
// we serve whatever is already cached — never fabricated rows.
import crypto from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { pool, query, one } from "./db.js";
import { authRequired } from "./auth.js";

// ---- normalization helpers ----

// "$1,001 - $15,000" -> [1001, 15000]; "Over $50,000,000" -> [50000000, 50000000]
export function parseAmount(s) {
  if (!s) return [null, null];
  const nums = [...String(s).matchAll(/\$?\s?([\d,]+)/g)]
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return [null, null];
  if (nums.length === 1) return [nums[0], nums[0]];
  return [Math.min(...nums), Math.max(...nums)];
}

// Accept YYYY-MM-DD or MM/DD/YYYY -> YYYY-MM-DD (or null).
export function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

// Map the many raw type strings to purchase | sale | exchange | other.
export function normType(s) {
  const t = String(s || "").toLowerCase();
  if (t.includes("purchase") || t === "buy") return "purchase";
  if (t.includes("sale") || t.includes("sold") || t === "sell") return "sale";
  if (t.includes("exchange")) return "exchange";
  return "other";
}

function cleanTicker(t) {
  const s = String(t || "").trim().toUpperCase();
  return s === "--" || s === "N/A" || s === "--." ? "" : s.replace(/[^A-Z0-9.\-]/g, "");
}

function externalId(rec) {
  const key = [rec.chamber, rec.member, rec.ticker, rec.tx_date, rec.tx_type, rec.amount_low, rec.amount_high].join("|");
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 32);
}

function normalizeHouse(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const [lo, hi] = parseAmount(r.amount);
    const rec = {
      chamber: "house",
      member: (r.representative || "").replace(/^Hon\.?\s*/i, "").trim(),
      party: r.party || null,
      ticker: cleanTicker(r.ticker),
      asset_description: r.asset_description || null,
      tx_type: normType(r.type),
      amount_low: lo, amount_high: hi,
      tx_date: parseDate(r.transaction_date),
      disclosed_date: parseDate(r.disclosure_date),
      source: "house-stock-watcher",
    };
    rec.external_id = externalId(rec);
    return rec;
  });
}

function normalizeSenate(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const [lo, hi] = parseAmount(r.amount);
    const rec = {
      chamber: "senate",
      member: (r.senator || "").trim(),
      party: r.party || null,
      ticker: cleanTicker(r.ticker),
      asset_description: r.asset_description || null,
      tx_type: normType(r.type),
      amount_low: lo, amount_high: hi,
      tx_date: parseDate(r.transaction_date),
      disclosed_date: parseDate(r.disclosure_date),
      source: "senate-stock-watcher",
    };
    rec.external_id = externalId(rec);
    return rec;
  });
}

async function fetchJson(url, ms = 30000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "SignalDesk/0.1" } });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

// ---- sync ----

let syncing = false;
export async function syncCongress() {
  if (syncing) return { ok: false, reason: "already syncing" };
  syncing = true;
  try {
    const [house, senate] = await Promise.all([
      fetchJson(config.congress.houseUrl).catch((e) => { console.warn("[congress] house fetch failed:", e.message); return null; }),
      fetchJson(config.congress.senateUrl).catch((e) => { console.warn("[congress] senate fetch failed:", e.message); return null; }),
    ]);
    const recs = [...normalizeHouse(house), ...normalizeSenate(senate)].filter((r) => r.external_id && (r.tx_date || r.disclosed_date));
    if (!recs.length) {
      await query("UPDATE congress_sync SET last_synced_at = now(), status = $1, rows_ingested = 0 WHERE id = 1", ["no_data"]);
      return { ok: false, reason: "no data from sources" };
    }
    // de-dupe in memory, then chunked upsert
    const seen = new Set();
    const unique = recs.filter((r) => (seen.has(r.external_id) ? false : seen.add(r.external_id)));
    const cols = ["external_id", "chamber", "member", "party", "ticker", "asset_description", "tx_type", "amount_low", "amount_high", "tx_date", "disclosed_date", "source"];
    let ingested = 0;
    for (let i = 0; i < unique.length; i += 400) {
      const chunk = unique.slice(i, i + 400);
      const values = [];
      const params = [];
      chunk.forEach((r, j) => {
        const base = j * cols.length;
        values.push(`(${cols.map((_, k) => `$${base + k + 1}`).join(",")})`);
        params.push(r.external_id, r.chamber, r.member, r.party, r.ticker, r.asset_description, r.tx_type, r.amount_low, r.amount_high, r.tx_date, r.disclosed_date, r.source);
      });
      const sql = `INSERT INTO congress_trades (${cols.join(",")}) VALUES ${values.join(",")} ON CONFLICT (external_id) DO NOTHING`;
      const res = await query(sql, params);
      ingested += res.rowCount || 0;
    }
    await query("UPDATE congress_sync SET last_synced_at = now(), status = $1, rows_ingested = $2 WHERE id = 1", ["ok", ingested]);
    console.log(`[congress] synced — ${unique.length} records seen, ${ingested} new`);
    return { ok: true, seen: unique.length, ingested };
  } catch (e) {
    await query("UPDATE congress_sync SET last_synced_at = now(), status = $1 WHERE id = 1", ["error"]).catch(() => {});
    return { ok: false, reason: e.message };
  } finally {
    syncing = false;
  }
}

// Refresh if stale; on an empty table, block once so the first response has data.
async function ensureFresh() {
  const sync = await one("SELECT last_synced_at FROM congress_sync WHERE id = 1");
  const count = await one("SELECT count(*)::int AS n FROM congress_trades");
  const ageMs = sync && sync.last_synced_at ? Date.now() - new Date(sync.last_synced_at).getTime() : Infinity;
  if (!count || count.n === 0) { await syncCongress(); return; }         // first ever — block
  if (ageMs > config.congress.ttlHours * 3600_000) syncCongress();        // stale — refresh in background
}

// ---- routes ----

export const congressRouter = express.Router();

// Recent disclosures, optionally filtered by type.
congressRouter.get("/recent", authRequired, async (req, res) => {
  await ensureFresh();
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const type = normType(req.query.type);
  const params = [`${days} days`];
  let where = "tx_date >= now() - $1::interval";
  if (["purchase", "sale", "exchange"].includes(type)) { params.push(type); where += ` AND tx_type = $${params.length}`; }
  params.push(limit);
  const { rows } = await query(
    `SELECT chamber, member, party, ticker, tx_type, amount_low, amount_high, tx_date, disclosed_date
     FROM congress_trades WHERE ${where} ORDER BY tx_date DESC, disclosed_date DESC LIMIT $${params.length}`,
    params
  );
  res.json({ days, count: rows.length, trades: rows });
});

// All disclosures for one ticker.
congressRouter.get("/ticker/:symbol", authRequired, async (req, res) => {
  await ensureFresh();
  const sym = cleanTicker(req.params.symbol);
  if (!sym) return res.status(400).json({ error: "bad_ticker" });
  const days = Math.min(730, Math.max(1, Number(req.query.days) || 180));
  const { rows } = await query(
    `SELECT chamber, member, party, tx_type, amount_low, amount_high, tx_date, disclosed_date
     FROM congress_trades WHERE ticker = $1 AND tx_date >= now() - $2::interval
     ORDER BY tx_date DESC LIMIT 200`,
    [sym, `${days} days`]
  );
  res.json({ ticker: sym, count: rows.length, trades: rows });
});

// "Investment spikes": tickers several members are trading recently.
congressRouter.get("/spikes", authRequired, async (req, res) => {
  await ensureFresh();
  const days = Math.min(120, Math.max(1, Number(req.query.days) || 30));
  const minMembers = Math.max(2, Number(req.query.minMembers) || 2);
  const { rows } = await query(
    `SELECT ticker,
            count(*)::int AS trades,
            count(distinct member)::int AS members,
            sum((tx_type = 'purchase')::int)::int AS buys,
            sum((tx_type = 'sale')::int)::int AS sells,
            max(tx_date) AS latest
     FROM congress_trades
     WHERE ticker <> '' AND tx_date >= now() - $1::interval
     GROUP BY ticker
     HAVING count(distinct member) >= $2
     ORDER BY members DESC, buys DESC, trades DESC
     LIMIT 25`,
    [`${days} days`, minMembers]
  );
  res.json({ days, spikes: rows });
});

// Force a refresh.
congressRouter.post("/sync", authRequired, async (_req, res) => {
  const r = await syncCongress();
  res.status(r.ok ? 200 : 502).json(r);
});
