// The default venue is an in-memory book. These tests never call a network
// and never pass a live broker function.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaperBroker } from "../js/paper-broker.mjs";

test("buys spend cash and sells realize average-cost P&L", async () => {
  const book = createPaperBroker({ startingCash: 10_000 });
  const buy = await book.placeEquityOrder({ symbol: "aaa", side: "buy", quantity: "10", limit_price: "100", ref_id: "b1" });
  assert.equal(buy.state, "filled");
  assert.equal(buy.paper, true);
  assert.equal(buy.symbol, "AAA");
  let snap = book.snapshot();
  assert.equal(snap.cash, 9000);
  assert.equal(snap.positions[0].shares, 10);
  assert.equal(snap.positions[0].avgPrice, 100);

  const add = await book.placeEquityOrder({ symbol: "AAA", side: "buy", quantity: "10", limit_price: "120" });
  assert.equal(add.state, "filled");
  snap = book.snapshot();
  assert.equal(snap.positions[0].avgPrice, 110);
  assert.equal(snap.cash, 7800);

  const sell = await book.placeEquityOrder({ symbol: "AAA", side: "sell", quantity: "10", fill_price: "130" });
  assert.equal(sell.state, "filled");
  assert.equal(sell.realizedPnl, 200);
  snap = book.snapshot();
  assert.equal(snap.realizedPnl, 200);
  assert.equal(snap.positions.length, 1);
  assert.equal(snap.positions[0].shares, 10);
  assert.equal(snap.cash, 9100);
});

test("a sell that would open a short is rejected and does not change the book", async () => {
  const book = createPaperBroker({ startingCash: 1000 });
  const res = await book.placeEquityOrder({ symbol: "AAA", side: "sell", quantity: "1", limit_price: "50" });
  assert.equal(res.state, "rejected");
  assert.equal(res.reason, "short-not-allowed");
  assert.equal(book.snapshot().fills.length, 0);
  assert.equal(book.snapshot().cash, 1000);
});

test("insufficient cash is rejected", async () => {
  const book = createPaperBroker({ startingCash: 50 });
  const res = await book.placeEquityOrder({ symbol: "AAA", side: "buy", quantity: "1", limit_price: "100" });
  assert.equal(res.state, "rejected");
  assert.equal(res.reason, "insufficient-cash");
  assert.equal(book.snapshot().positions.length, 0);
});

test("market-style orders fill at fill_price and a missing price is rejected", async () => {
  const book = createPaperBroker({ startingCash: 1000 });
  const bad = await book.placeEquityOrder({ symbol: "AAA", side: "buy", quantity: "1", type: "market" });
  assert.equal(bad.reason, "no-price");
  const ok = await book.placeEquityOrder({ symbol: "AAA", side: "buy", quantity: "1", fill_price: "10" });
  assert.equal(ok.state, "filled");
  assert.equal(ok.fill_price, "10");
});
