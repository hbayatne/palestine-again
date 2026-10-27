// decision-log.mjs
// Append-only audit trail for every trading decision and action. This is the
// black box recorder: once a line is written it is never rewritten or deleted,
// so there is always a tamper-evident record of what the engine decided, why,
// and whether a human approved it. Two formats:
//   - JSONL (default): one JSON object per line — lossless, easy to diff/grep.
//   - CSV: a flat row per record — easy to open in a spreadsheet.
//
// The log is intentionally dumb: it only ever appends (fs flag "a"). There is no
// update or delete API, by design. Reading back is for display/tests only.
//
// Node-only (uses node:fs). It is NOT part of the browser bundle (see build.mjs).
// Every public call is guarded so that, if somehow loaded without a filesystem,
// it degrades to an in-memory buffer instead of throwing.

let fs = null;
try {
  fs = (await import("node:fs")).default;
} catch {
  fs = null; // non-Node environment: fall back to an in-memory ring buffer
}

const CSV_COLUMNS = [
  "ts", "cycle", "kind", "mode", "dryRun", "symbol", "side", "shares",
  "price", "entry", "stop", "target", "notional", "approved", "reason",
];

// Fields that must never be written to the log in the clear. Defensive: the
// engine does not pass secrets today, but an append-only audit file is exactly
// the place you do NOT want a token to leak into.
const REDACT_KEYS = /token|secret|password|apikey|api_key|authorization|cookie/i;

function sanitize(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (REDACT_KEYS.test(k)) { out[k] = "[redacted]"; continue; }
    out[k] = v;
  }
  return out;
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsvRow(rec) {
  return CSV_COLUMNS.map((c) => csvEscape(rec[c])).join(",");
}

// Create a logger bound to a file path. format ∈ "jsonl" | "csv".
// Returns { append, readAll, path, format } — note: NO update/delete, on purpose.
export function createDecisionLog(opts = {}) {
  const path = opts.path || process?.env?.TRADE_LOG_PATH || "trade-decisions.log.jsonl";
  const format = opts.format === "csv" ? "csv" : "jsonl";
  const mem = []; // in-memory mirror / fallback when fs is unavailable

  // For CSV, make sure the header row exists exactly once (only when creating).
  if (format === "csv" && fs && !fs.existsSync(path)) {
    try { fs.writeFileSync(path, CSV_COLUMNS.join(",") + "\n", { flag: "wx" }); } catch { /* raced; fine */ }
  }

  function append(entry) {
    const rec = { ts: new Date().toISOString(), ...sanitize(entry) };
    mem.push(rec);
    const line = format === "csv" ? toCsvRow(rec) : JSON.stringify(rec);
    if (fs) {
      // flag "a" = append-only. We never open this file for truncation.
      fs.appendFileSync(path, line + "\n", { encoding: "utf8", flag: "a" });
    }
    return rec;
  }

  function readAll() {
    if (fs && fs.existsSync(path)) {
      const text = fs.readFileSync(path, "utf8");
      const lines = text.split("\n").filter((l) => l.trim().length);
      if (format === "csv") return lines.slice(1).map(parseCsvLine); // drop header
      return lines.map((l) => { try { return JSON.parse(l); } catch { return { malformed: l }; } });
    }
    return mem.slice();
  }

  return { append, readAll, path, format };
}

function parseCsvLine(line) {
  // Minimal CSV parser sufficient for the flat rows this module writes.
  const cells = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  const rec = {};
  CSV_COLUMNS.forEach((c, i) => { rec[c] = cells[i] ?? ""; });
  return rec;
}

// A no-op logger for callers that explicitly want logging disabled (keeps the
// loop code branch-free — it always has something to call).
export function nullLog() {
  const mem = [];
  return { append: (e) => { const r = { ts: new Date().toISOString(), ...e }; mem.push(r); return r; },
           readAll: () => mem.slice(), path: null, format: "memory" };
}
