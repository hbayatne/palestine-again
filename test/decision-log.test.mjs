// Tests for the append-only decision/trade audit log.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecisionLog, nullLog } from "../js/decision-log.mjs";

const tmp = [];
function tmpPath(ext) {
  const p = path.join(os.tmpdir(), `declog-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  tmp.push(p);
  return p;
}
afterEach(() => { for (const p of tmp.splice(0)) { try { fs.unlinkSync(p); } catch {} } });

test("JSONL: appends records and reads them back in order", () => {
  const log = createDecisionLog({ path: tmpPath("jsonl") });
  log.append({ kind: "ENTER", symbol: "AAA", shares: 2 });
  log.append({ kind: "EXIT", symbol: "AAA", pnl: 10 });
  const rows = log.readAll();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, "AAA");
  assert.equal(rows[0].kind, "ENTER");
  assert.equal(rows[1].kind, "EXIT");
  assert.ok(rows[0].ts, "each record is timestamped");
});

test("is append-only: new appends never rewrite earlier lines", () => {
  const p = tmpPath("jsonl");
  const a = createDecisionLog({ path: p });
  a.append({ kind: "ENTER", symbol: "AAA" });
  // A second logger opening the SAME path must preserve the first line.
  const b = createDecisionLog({ path: p });
  b.append({ kind: "ENTER", symbol: "BBB" });
  const rows = b.readAll();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, "AAA");
  assert.equal(rows[1].symbol, "BBB");
  // raw file still has exactly 2 lines (append mode, no truncation)
  const lines = fs.readFileSync(p, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
});

test("exposes no update or delete API (audit integrity)", () => {
  const log = createDecisionLog({ path: tmpPath("jsonl") });
  assert.equal(typeof log.append, "function");
  assert.equal(typeof log.readAll, "function");
  assert.equal(log.update, undefined);
  assert.equal(log.delete, undefined);
  assert.equal(log.clear, undefined);
});

test("CSV: writes a header once and parses rows back", () => {
  const p = tmpPath("csv");
  const log = createDecisionLog({ path: p, format: "csv" });
  log.append({ kind: "ENTER", symbol: "AAA", shares: 2, reason: "has, comma" });
  log.append({ kind: "SKIP", symbol: "BBB", reason: "guard" });
  const raw = fs.readFileSync(p, "utf8").trim().split("\n");
  assert.match(raw[0], /^ts,cycle,kind/);        // header present
  assert.equal(raw.length, 3);                   // header + 2 rows
  const rows = log.readAll();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, "AAA");
  assert.equal(rows[0].reason, "has, comma");    // comma survived quoting round-trip
});

test("redacts secret-like fields before writing", () => {
  const log = createDecisionLog({ path: tmpPath("jsonl") });
  log.append({ kind: "ENTER", symbol: "AAA", apiKey: "sk-123", token: "abc" });
  const rows = log.readAll();
  assert.equal(rows[0].apiKey, "[redacted]");
  assert.equal(rows[0].token, "[redacted]");
  assert.equal(rows[0].symbol, "AAA");
});

test("nullLog keeps records in memory without touching disk", () => {
  const log = nullLog();
  log.append({ kind: "ENTER", symbol: "AAA" });
  assert.equal(log.readAll().length, 1);
  assert.equal(log.path, null);
});
