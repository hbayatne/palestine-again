// Unit tests — pure logic, no database. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmount, parseDate, normType, normalizeHouse, normalizeSenate } from "../src/congress.js";
import { entitlementsFor, limitFor, requireEntitlement } from "../src/entitlements.js";

test("parseAmount handles ranges, single values and 'Over'", () => {
  assert.deepEqual(parseAmount("$1,001 - $15,000"), [1001, 15000]);
  assert.deepEqual(parseAmount("$1,000,001 - $5,000,000"), [1000001, 5000000]);
  assert.deepEqual(parseAmount("Over $50,000,000"), [50000000, 50000000]);
  assert.deepEqual(parseAmount(""), [null, null]);
  assert.deepEqual(parseAmount(null), [null, null]);
});

test("parseDate normalizes both formats, rejects junk", () => {
  assert.equal(parseDate("09/15/2026"), "2026-09-15");
  assert.equal(parseDate("2026-09-15"), "2026-09-15");
  assert.equal(parseDate("9/5/2026"), "2026-09-05");
  assert.equal(parseDate("n/a"), null);
  assert.equal(parseDate(""), null);
});

test("normType maps raw strings to canonical types", () => {
  assert.equal(normType("purchase"), "purchase");
  assert.equal(normType("sale_full"), "sale");
  assert.equal(normType("Sale (Partial)"), "sale");
  assert.equal(normType("Exchange"), "exchange");
  assert.equal(normType("weird"), "other");
});

test("normalizeHouse produces canonical records with a stable id", () => {
  const recs = normalizeHouse([
    { representative: "Hon. Jane Doe", ticker: "aapl", type: "purchase", amount: "$1,001 - $15,000", transaction_date: "09/15/2026", disclosure_date: "09/20/2026" },
    { representative: "Hon. Jane Doe", ticker: "--", type: "sale_full", amount: "$1,001 - $15,000", transaction_date: "2026-09-10" },
  ]);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].chamber, "house");
  assert.equal(recs[0].member, "Jane Doe");       // "Hon." stripped
  assert.equal(recs[0].ticker, "AAPL");
  assert.equal(recs[0].tx_type, "purchase");
  assert.deepEqual([recs[0].amount_low, recs[0].amount_high], [1001, 15000]);
  assert.equal(recs[1].ticker, "");               // "--" cleaned to empty
  assert.match(recs[0].external_id, /^[0-9a-f]{32}$/);
  assert.notEqual(recs[0].external_id, recs[1].external_id);
});

test("normalizeSenate reads senator field", () => {
  const recs = normalizeSenate([
    { senator: "John Roe", ticker: "MSFT", type: "Purchase", amount: "$15,001 - $50,000", transaction_date: "10/01/2026" },
  ]);
  assert.equal(recs[0].chamber, "senate");
  assert.equal(recs[0].member, "John Roe");
  assert.equal(recs[0].tx_type, "purchase");
});

test("entitlements gate by tier", () => {
  assert.equal(entitlementsFor("free")["backtest.enabled"], false);
  assert.equal(entitlementsFor("pro")["backtest.enabled"], true);
  assert.equal(entitlementsFor("bogus").tier, "free"); // unknown tier → free
  assert.equal(limitFor("pro", "alerts.max"), 500);
  assert.equal(limitFor("free", "alerts.max"), 3);
});

test("requireEntitlement middleware allows/denies correctly", () => {
  const mw = requireEntitlement("backtest.enabled");
  let nexted = false;
  mw({ user: { tier: "pro" } }, { status: () => ({ json: () => {} }) }, () => { nexted = true; });
  assert.equal(nexted, true);

  let code = 0;
  const res = { status: (c) => { code = c; return { json: () => {} }; } };
  mw({ user: { tier: "free" } }, res, () => { throw new Error("should not call next"); });
  assert.equal(code, 403);
});
