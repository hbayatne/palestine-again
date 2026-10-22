// Integration tests — exercise the real app against a real Postgres.
// Skipped automatically unless DATABASE_URL is set (CI provides a postgres
// service; locally, point it at a throwaway database to run these).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || "ci-test-secret-at-least-16-chars-long";

let app, server, base, pool;

before(async (t) => {
  if (!HAS_DB) return;
  const { runMigrations } = await import("../src/migrate.js");
  await runMigrations();
  ({ pool } = await import("../src/db.js"));
  ({ app } = await import("../src/index.js"));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
});

test("health check responds ok", { skip: !HAS_DB }, async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test("signup → login → me round-trip", { skip: !HAS_DB }, async () => {
  const email = `test_${Date.now()}@example.com`;
  const password = "supersecret123";

  const su = await fetch(`${base}/auth/signup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(su.status, 201);
  const { token, user } = await su.json();
  assert.ok(token);
  assert.equal(user.tier, "free");
  assert.equal(user.entitlements["backtest.enabled"], false);

  const li = await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(li.status, 200);

  const me = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, email);

  const noAuth = await fetch(`${base}/auth/me`);
  assert.equal(noAuth.status, 401);
});

test("congress ticker endpoint returns cached rows (public, no auth)", { skip: !HAS_DB }, async () => {
  // Insert a known row directly, bypassing the external sync, so the test is
  // deterministic and offline. Mark the sync table fresh so ensureFresh no-ops.
  await pool.query(
    `INSERT INTO congress_trades (external_id, chamber, member, ticker, tx_type, amount_low, amount_high, tx_date, source)
     VALUES ('itest-aapl-1','house','Test Member','AAPL','purchase',1001,15000, now()::date, 'test')
     ON CONFLICT (external_id) DO NOTHING`
  );
  await pool.query("UPDATE congress_sync SET last_synced_at = now(), status = 'ok' WHERE id = 1");

  const res = await fetch(`${base}/api/congress/ticker/AAPL`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ticker, "AAPL");
  assert.ok(body.trades.some((t) => t.member === "Test Member" && t.tx_type === "purchase"));
});
