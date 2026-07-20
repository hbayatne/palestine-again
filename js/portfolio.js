// portfolio.js — paper-trading simulator. A fake cash balance and positions,
// stored per logged-in user in localStorage, trading at real live prices.
// Purely simulated — no real orders, no real money.

const START_CASH = 100000;

function keyFor(email) {
  return "signaldesk_portfolio_" + (email || "guest");
}

function fresh() {
  return {
    cash: START_CASH,
    positions: {},
    history: [],
    equity: [{ ts: Date.now(), total: START_CASH }],
    created: Date.now(),
  };
}

// Record an equity-curve point (deduped to at most one per 5 minutes) so the
// paper account has a performance history to chart.
export function snapshot(email, total) {
  const p = load(email);
  if (!Array.isArray(p.equity)) p.equity = [];
  const lastPt = p.equity[p.equity.length - 1];
  const now = Date.now();
  if (!lastPt || now - lastPt.ts > 5 * 60 * 1000) {
    p.equity.push({ ts: now, total });
    p.equity = p.equity.slice(-500);
    save(email, p);
  } else {
    lastPt.total = total; // keep the latest value for the current bucket
    lastPt.ts = now;
    save(email, p);
  }
  return p.equity;
}

export function load(email) {
  try {
    const p = JSON.parse(localStorage.getItem(keyFor(email)));
    if (p && typeof p.cash === "number" && p.positions) return p;
  } catch {
    /* fall through */
  }
  return fresh();
}

export function save(email, p) {
  localStorage.setItem(keyFor(email), JSON.stringify(p));
}

export function reset(email) {
  const p = fresh();
  save(email, p);
  return p;
}

// Execute a simulated market order. side: "buy" | "sell". Returns {error} or {ok, portfolio}.
export function trade(email, side, symbol, qty, price) {
  symbol = (symbol || "").trim().toUpperCase();
  qty = Number(qty);
  price = Number(price);
  if (!symbol) return { error: "Enter a symbol." };
  if (!(qty > 0)) return { error: "Quantity must be greater than zero." };
  if (!(price > 0)) return { error: "No live price available for this symbol." };

  const p = load(email);
  const cost = qty * price;

  if (side === "buy") {
    if (cost > p.cash + 1e-6) return { error: `Not enough cash. Need $${cost.toFixed(2)}, have $${p.cash.toFixed(2)}.` };
    p.cash -= cost;
    const pos = p.positions[symbol] || { qty: 0, avgCost: 0 };
    const newQty = pos.qty + qty;
    pos.avgCost = (pos.qty * pos.avgCost + qty * price) / newQty;
    pos.qty = newQty;
    p.positions[symbol] = pos;
  } else if (side === "sell") {
    const pos = p.positions[symbol];
    if (!pos || pos.qty < qty - 1e-9) return { error: `You only hold ${pos ? pos.qty : 0} ${symbol}.` };
    p.cash += cost;
    const realized = (price - pos.avgCost) * qty;
    pos.qty -= qty;
    if (pos.qty <= 1e-9) delete p.positions[symbol];
    else p.positions[symbol] = pos;
    p.lastRealized = realized;
  } else {
    return { error: "Unknown order side." };
  }

  p.history.unshift({ ts: Date.now(), side, symbol, qty, price, value: cost });
  p.history = p.history.slice(0, 100);
  save(email, p);
  return { ok: true, portfolio: p };
}

// Given a portfolio and a {symbol: price} map, compute valuation + P&L.
export function value(p, prices) {
  let holdingsValue = 0;
  let costBasis = 0;
  const rows = [];
  for (const [sym, pos] of Object.entries(p.positions)) {
    const price = prices[sym];
    const mkt = price != null ? pos.qty * price : null;
    const basis = pos.qty * pos.avgCost;
    if (mkt != null) holdingsValue += mkt;
    costBasis += basis;
    rows.push({
      symbol: sym,
      qty: pos.qty,
      avgCost: pos.avgCost,
      price: price ?? null,
      marketValue: mkt,
      pnl: mkt != null ? mkt - basis : null,
      pnlPct: mkt != null && basis > 0 ? ((mkt - basis) / basis) * 100 : null,
    });
  }
  rows.sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
  const total = p.cash + holdingsValue;
  return {
    cash: p.cash,
    holdingsValue,
    total,
    totalPnl: total - START_CASH,
    totalPnlPct: ((total - START_CASH) / START_CASH) * 100,
    rows,
  };
}

export const STARTING_CASH = START_CASH;
