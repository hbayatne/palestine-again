// Tests for the market-structure primitives behind the engine: pivots, trend
// classification, and BOS / CHoCH detection. These lock in the behaviour the
// review examined so a future refactor can't silently change it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pivots, structure, detectPatterns } from "../js/patterns.js";

function fromCloses(closes, vol = 1000) {
  return closes.map((p, i) => ({ time: i, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: vol }));
}

test("pivots finds a clean swing high and low", () => {
  // index 3 is a strict local high, index 7 a strict local low
  const closes = [1, 2, 3, 9, 3, 2, 1, 0.2, 1, 2, 3];
  const { highs, lows } = pivots(fromCloses(closes), 3, 3);
  assert.ok(highs.some((h) => h.index === 3), "peak at i=3");
  assert.ok(lows.some((l) => l.index === 7), "trough at i=7");
});

test("structure classifies a rising sawtooth as an uptrend", () => {
  const closes = [];
  for (let i = 0; i < 60; i++) closes.push(100 + i * 0.6 + 3 * Math.sin((i * 2 * Math.PI) / 8));
  const st = structure(fromCloses(closes), 3, 3);
  assert.equal(st.trend, "up");
});

test("BOS up fires when price closes above the last swing high in an uptrend", () => {
  const closes = [];
  for (let i = 0; i < 60; i++) closes.push(100 + i * 0.6 + 3 * Math.sin((i * 2 * Math.PI) / 8));
  const base = fromCloses(closes);
  const lastHigh = structure(base, 3, 3).lastHigh.price;
  base.push({ time: 60, open: lastHigh, high: lastHigh + 2, low: lastHigh - 1, close: lastHigh * 1.03, volume: 4000 });
  const st = structure(base, 3, 3);
  assert.ok(st.bos && st.bos.direction === "up", "BOS up detected");
  assert.equal(st.choch, null);
});

test("CHoCH down fires when an uptrend closes below its last swing low", () => {
  const closes = [];
  for (let i = 0; i < 60; i++) closes.push(100 + i * 0.6 + 3 * Math.sin((i * 2 * Math.PI) / 8));
  const base = fromCloses(closes);
  const lastLow = structure(base, 3, 3).lastLow.price;
  base.push({ time: 60, open: lastLow, high: lastLow + 1, low: lastLow - 3, close: lastLow * 0.97, volume: 4000 });
  const st = structure(base, 3, 3);
  assert.ok(st.choch && st.choch.direction === "down", "CHoCH down detected");
});

test("detectPatterns returns null on a flat, featureless series", () => {
  const flat = fromCloses(new Array(80).fill(100));
  const { best } = detectPatterns(flat);
  assert.equal(best, null);
});
