// robinhood-exec.mjs
// The ONLY place the engine is allowed to translate an approved decision into a
// real Robinhood order. It is deliberately paranoid. Three independent gates,
// each of which alone is sufficient to stop an order:
//
//   1. live === false (THE DEFAULT) — the broker functions are never called;
//      execute() returns the order it *would* have sent, for inspection.
//   2. A BUY must arrive already approved (action.approved === true). The loop
//      stamps this only after a human says yes. An unapproved buy is refused
//      here too, so a wiring mistake upstream still cannot place it.
//   3. Shorting is refused outright (the Agentic account is cash-only).
//
// The broker itself is injected (`placeEquityOrder`), so this module never
// imports or hard-codes any MCP tool. Nothing here places an order on its own;
// it only runs when the live loop calls execute() in a live, approved context.

import { randomUUID } from "node:crypto";

export function createRobinhoodExecutor(opts = {}) {
  const {
    placeEquityOrder,            // async ({account_number, symbol, side, ...}) => order
    accountNumber = null,        // required when live
    live = false,                // DEFAULT OFF — dry-run unless explicitly armed
    entryType = "limit",         // buys rest as a limit at the signal entry
    exitType = "market",         // exits/scale-outs close at market
    timeInForce = "gtc",
    marketHours = "regular_hours",
    log = () => {},
    audit = null,                // optional decision-log to record every send/withhold
  } = opts;

  const record = (rec) => { try { audit?.append?.({ source: "robinhood-exec", ...rec }); } catch {} };

  async function execute(action) {
    const mapped = buildOrder(action, { accountNumber, entryType, exitType, timeInForce, marketHours });

    // Gate 1: dry-run. Never calls the broker.
    if (!live) {
      log(`[dry-run] would ${describe(mapped)} — NOT sent`);
      record({ kind: "WOULD_SEND", live: false, ...flat(action, mapped) });
      return { placed: false, dryRun: true, wouldSend: mapped };
    }

    // Gate 2: a buy must be approved. Defense-in-depth with the loop's gate.
    if (isBuy(action) && action.approved !== true) {
      log(`REFUSED unapproved buy ${action.symbol} — no order sent`);
      record({ kind: "REFUSED_UNAPPROVED", live: true, ...flat(action, mapped) });
      return { placed: false, blocked: "unapproved-buy" };
    }

    // Gate 3: no shorting in a cash account.
    if (action.type === "ENTER" && action.side === "SHORT") {
      log(`REFUSED short entry ${action.symbol} — cash account cannot short`);
      record({ kind: "REFUSED_SHORT", live: true, ...flat(action, mapped) });
      return { placed: false, blocked: "short-not-allowed" };
    }

    if (typeof placeEquityOrder !== "function")
      return { placed: false, blocked: "no-broker-wired" };
    if (!accountNumber)
      return { placed: false, blocked: "no-account-number" };

    // Armed, approved, non-short: this is the one line that reaches the broker.
    const res = await placeEquityOrder(mapped);
    log(`SENT ${describe(mapped)} (ref ${mapped.ref_id})`);
    record({ kind: "SENT", live: true, ref_id: mapped.ref_id, ...flat(action, mapped) });
    return { placed: true, order: mapped, result: res };
  }

  return { execute, live, accountNumber };
}

function isBuy(action) {
  // A buy = opening a long. Exits and scale-outs are sells (risk-reducing).
  return action.type === "ENTER" && action.side === "LONG";
}

// Translate an engine action into Robinhood place_equity_order params.
export function buildOrder(action, cfg = {}) {
  const { accountNumber, entryType = "limit", exitType = "market",
    timeInForce = "gtc", marketHours = "regular_hours" } = cfg;
  const base = {
    account_number: accountNumber,
    symbol: action.symbol,
    quantity: String(action.shares),
    time_in_force: timeInForce,
    market_hours: marketHours,
    ref_id: action.ref_id || randomUUID(),
  };
  if (action.type === "ENTER") {
    const buy = action.side === "LONG";
    return {
      ...base,
      side: buy ? "buy" : "sell",       // SHORT is refused before this runs
      type: entryType,
      ...(entryType === "limit" ? { limit_price: String(action.entry) } : {}),
    };
  }
  // EXIT / SCALE_OUT — close or trim a long: sell.
  return {
    ...base,
    side: "sell",
    quantity: String(action.shares),
    type: exitType,
    ...(exitType === "limit" ? { limit_price: String(action.price ?? action.target ?? action.stop) } : {}),
  };
}

function describe(o) {
  return `${o.side} ${o.quantity} ${o.symbol} ${o.type}${o.limit_price ? ` @ ${o.limit_price}` : ""}`;
}
function flat(action, mapped) {
  return { symbol: action.symbol, type: action.type, side: action.side,
    shares: action.shares, approved: action.approved === true,
    order_side: mapped.side, order_type: mapped.type };
}
