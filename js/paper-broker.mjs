// paper-broker.mjs
// In-memory paper broker. This is the default venue: it fills orders against a
// fake cash balance and a long-only position book that live entirely in this
// process. It does not open a socket, read credentials, or call any broker.
//
// placeEquityOrder here is a local function with the same shape as a broker
// adapter. It is NOT the injected live hook and it never forwards to one.

const DEFAULT_CASH = 100_000;

export function createPaperBroker(opts = {}) {
  const startingCash = finite(opts.startingCash, DEFAULT_CASH);
  let cash = startingCash;
  /** @type {Map<string, {symbol: string, shares: number, avgPrice: number}>} */
  const positions = new Map();
  const fills = [];
  let seq = 0;

  function snapshot() {
    const open = [...positions.values()].map((p) => ({
      symbol: p.symbol,
      shares: p.shares,
      avgPrice: p.avgPrice,
    }));
    const realizedPnl = round2(fills.reduce((s, f) => s + (f.realizedPnl || 0), 0));
    return {
      startingCash,
      cash: round2(cash),
      positions: open,
      fills: fills.map((f) => ({ ...f })),
      realizedPnl,
    };
  }

  // Broker-shaped local fill. `order` is the mapped equity order plus an
  // optional fill_price (market orders have no limit_price). Rejects instead
  // of throwing so a paper problem cannot be mistaken for a live send.
  async function placeEquityOrder(order) {
    if (!order || typeof order !== "object") return reject("bad-order");
    const symbol = String(order.symbol || "").trim().toUpperCase();
    const side = String(order.side || "").toLowerCase();
    const qty = Number(order.quantity);
    const px = resolvePrice(order);
    if (!symbol) return reject("missing-symbol");
    if (side !== "buy" && side !== "sell") return reject("bad-side");
    if (!Number.isFinite(qty) || qty <= 0) return reject("bad-quantity");
    if (!Number.isFinite(px) || px <= 0) return reject("no-price");

    const pos = positions.get(symbol) || { symbol, shares: 0, avgPrice: 0 };

    if (side === "sell") {
      if (pos.shares + 1e-8 < qty) {
        return reject("short-not-allowed", { symbol, have: pos.shares, want: qty });
      }
      const realized = (px - pos.avgPrice) * qty;
      pos.shares = cleanShares(pos.shares - qty);
      cash += px * qty;
      if (pos.shares <= 0) positions.delete(symbol);
      else positions.set(symbol, pos);
      return recordFill({ order, symbol, side, qty, px, realized });
    }

    const cost = px * qty;
    if (cash + 1e-8 < cost) return reject("insufficient-cash", { cash: round2(cash), cost: round2(cost) });
    const newShares = pos.shares + qty;
    pos.avgPrice = newShares > 0 ? ((pos.avgPrice * pos.shares) + cost) / newShares : px;
    pos.shares = cleanShares(newShares);
    cash -= cost;
    positions.set(symbol, pos);
    return recordFill({ order, symbol, side, qty, px, realized: 0 });
  }

  function recordFill({ order, symbol, side, qty, px, realized }) {
    seq += 1;
    const fill = {
      id: order.ref_id || `paper-${seq}`,
      state: "filled",
      paper: true,
      symbol,
      side,
      quantity: String(qty),
      fill_price: String(px),
      realizedPnl: round2(realized),
      ref_id: order.ref_id || null,
    };
    fills.push(fill);
    return { ...fill };
  }

  return { placeEquityOrder, snapshot };
}

function resolvePrice(order) {
  for (const key of ["fill_price", "limit_price", "price"]) {
    if (order[key] == null || order[key] === "") continue;
    const n = Number(order[key]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function reject(reason, extra = {}) {
  return { state: "rejected", paper: true, reason, ...extra };
}

function finite(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function cleanShares(n) {
  const r = Math.round(n * 1e8) / 1e8;
  return Math.abs(r) < 1e-8 ? 0 : r;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
