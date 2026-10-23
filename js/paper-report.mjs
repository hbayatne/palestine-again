// paper-report.mjs
// Paper profit/loss from a decision log. Replays paper trade events in order
// (average-cost, long-only) and reports realized P&L on sells plus unrealized
// P&L for whatever is still open. Live sends are ignored.
//
// Accepts either an array of records or a decision log `{ readAll() }`.
// This module does not place orders and does not touch a broker.

const TRADE_KINDS = new Set(["ENTER", "EXIT", "SCALE_OUT", "PAPER_FILL"]);

export function paperPnlReport(source, opts = {}) {
  const records = normalize(source);
  const marks = opts.marks || {};
  /** @type {Map<string, {symbol: string, shares: number, avgPrice: number, realized: number, buys: number, sells: number}>} */
  const book = new Map();
  const closedTrades = [];
  const warnings = [];
  let counted = 0;

  for (const rec of records) {
    const ev = toEvent(rec, warnings);
    if (!ev) continue;
    counted += 1;
    applyEvent(book, ev, closedTrades, warnings);
  }

  const openPositions = [];
  let unrealized = 0;
  for (const pos of book.values()) {
    if (pos.shares <= 0) continue;
    const mark = markFor(marks, pos.symbol);
    const row = {
      symbol: pos.symbol,
      shares: pos.shares,
      avgPrice: pos.avgPrice,
      mark,
      unrealized: mark == null ? null : round2((mark - pos.avgPrice) * pos.shares),
    };
    openPositions.push(row);
    if (row.unrealized != null) unrealized += row.unrealized;
  }

  const realizedPnl = round2(closedTrades.reduce((s, t) => s + t.pnl, 0));
  const unrealizedPnl = round2(unrealized);
  const bySymbol = {};
  for (const pos of book.values()) {
    const open = openPositions.find((p) => p.symbol === pos.symbol);
    bySymbol[pos.symbol] = {
      realizedPnl: round2(pos.realized),
      unrealizedPnl: open?.unrealized == null ? 0 : open.unrealized,
      openShares: pos.shares,
      avgPrice: pos.shares > 0 ? pos.avgPrice : 0,
      buys: pos.buys,
      sells: pos.sells,
    };
  }

  return {
    realizedPnl,
    unrealizedPnl,
    totalPnl: round2(realizedPnl + unrealizedPnl),
    closedTrades,
    openPositions,
    bySymbol,
    warnings,
    counted,
  };
}

export function formatPaperPnlReport(report) {
  const lines = [
    "Paper P&L",
    `realized: ${money(report.realizedPnl)}`,
    `unrealized: ${money(report.unrealizedPnl)}`,
    `total: ${money(report.totalPnl)}`,
    "closed:",
  ];
  if (!report.closedTrades.length) lines.push("  (none)");
  for (const t of report.closedTrades) {
    lines.push(
      `  ${t.symbol} ${fmtShares(t.shares)} @ ${fmtPx(t.entry)} -> ${fmtPx(t.exit)}  pnl ${money(t.pnl)}`
    );
  }
  lines.push("open:");
  if (!report.openPositions.length) lines.push("  (none)");
  for (const p of report.openPositions) {
    const mark = p.mark == null ? "unmarked" : `mark ${fmtPx(p.mark)}  uPnL ${money(p.unrealized)}`;
    lines.push(`  ${p.symbol} ${fmtShares(p.shares)} @ ${fmtPx(p.avgPrice)}  ${mark}`);
  }
  if (report.warnings.length) {
    lines.push("warnings:");
    for (const w of report.warnings) lines.push(`  ${w.symbol || "-"} ${w.reason}`);
  }
  return lines.join("\n");
}

function normalize(source) {
  if (Array.isArray(source)) return source;
  if (source && typeof source.readAll === "function") return source.readAll();
  throw new TypeError("paperPnlReport expects a decision log or an array of records");
}

// A record is a paper trade when it is a PAPER_FILL, or an ENTER / EXIT /
// SCALE_OUT that was not logged from a live cycle (dryRun:false).
// SENT and live:true rows are real-money events and are skipped.
function toEvent(rec, warnings) {
  if (!rec || typeof rec !== "object") return null;
  if (rec.live === true || rec.kind === "SENT") return null;
  if (!TRADE_KINDS.has(rec.kind)) return null;
  if (rec.paper === false) return null;
  // dryRun:false is a live-mode decision (placed or withheld). It is not paper.
  // Omitted dryRun stays paper so a bare ENTER/EXIT row still counts.
  // PAPER_FILL is an explicit paper fill and ignores dryRun.
  if (rec.kind !== "PAPER_FILL" && flag(rec.dryRun) === false) return null;

  const symbol = String(rec.symbol || "").trim().toUpperCase();
  const shares = Number(rec.shares ?? rec.quantity);
  const orderSide = direction(rec);
  const price = eventPrice(rec, orderSide);
  if (!symbol || !orderSide) {
    warnings.push({ symbol, reason: "unreadable-trade", kind: rec.kind });
    return null;
  }
  if (rec.side === "SHORT" || rec.positionSide === "SHORT") {
    warnings.push({ symbol, reason: "short-not-allowed", kind: rec.kind });
    return null;
  }
  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(price) || price <= 0) {
    warnings.push({ symbol, reason: "missing-price-or-size", kind: rec.kind });
    return null;
  }
  return { symbol, orderSide, shares, price, ts: rec.ts || null, kind: rec.kind };
}

function direction(rec) {
  if (rec.order_side === "buy" || rec.order_side === "sell") return rec.order_side;
  if (rec.side === "buy" || rec.side === "sell") return rec.side;
  const kind = rec.type || rec.kind;
  if (kind === "ENTER") return "buy";
  if (kind === "EXIT" || kind === "SCALE_OUT") return "sell";
  return null;
}

function eventPrice(rec, orderSide) {
  if (rec.price != null && rec.price !== "") {
    const n = Number(rec.price);
    if (Number.isFinite(n)) return n;
  }
  if (rec.fill_price != null && rec.fill_price !== "") {
    const n = Number(rec.fill_price);
    if (Number.isFinite(n)) return n;
  }
  if (orderSide === "buy" && rec.entry != null && rec.entry !== "") return Number(rec.entry);
  if (rec.limit_price != null && rec.limit_price !== "") return Number(rec.limit_price);
  return NaN;
}

function applyEvent(book, ev, closedTrades, warnings) {
  const pos = book.get(ev.symbol) || {
    symbol: ev.symbol, shares: 0, avgPrice: 0, realized: 0, buys: 0, sells: 0,
  };
  if (ev.orderSide === "buy") {
    const cost = ev.price * ev.shares;
    const newShares = pos.shares + ev.shares;
    pos.avgPrice = newShares > 0 ? ((pos.avgPrice * pos.shares) + cost) / newShares : ev.price;
    pos.shares = cleanShares(newShares);
    pos.buys += 1;
    book.set(ev.symbol, pos);
    return;
  }

  if (pos.shares <= 0) {
    warnings.push({ symbol: ev.symbol, reason: "sell-without-position", kind: ev.kind });
    book.set(ev.symbol, pos);
    return;
  }
  const qty = Math.min(ev.shares, pos.shares);
  if (qty + 1e-8 < ev.shares) {
    warnings.push({ symbol: ev.symbol, reason: "sell-exceeds-position", kind: ev.kind });
  }
  // Capture average cost before the position is reduced.
  const entry = pos.avgPrice;
  const pnl = round2((ev.price - entry) * qty);
  pos.realized += pnl;
  pos.shares = cleanShares(pos.shares - qty);
  pos.sells += 1;
  if (pos.shares <= 0) pos.avgPrice = 0;
  book.set(ev.symbol, pos);
  closedTrades.push({
    symbol: ev.symbol,
    shares: qty,
    entry: round4(entry),
    exit: ev.price,
    pnl,
    ts: ev.ts,
    kind: ev.kind,
  });
}

function flag(v) {
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return null;
}

function markFor(marks, symbol) {
  if (!marks || marks[symbol] == null || marks[symbol] === "") return null;
  const n = Number(marks[symbol]);
  return Number.isFinite(n) ? n : null;
}

function cleanShares(n) {
  const r = Math.round(n * 1e8) / 1e8;
  return Math.abs(r) < 1e-8 ? 0 : r;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function money(n) {
  const v = round2(Number(n) || 0);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtPx(n) {
  const v = round4(Number(n) || 0);
  return String(v);
}

function fmtShares(n) {
  return String(cleanShares(n));
}
