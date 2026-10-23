// robinhood-exec.mjs
// The ONLY place the engine is allowed to translate an approved decision into a
// real Robinhood order. It is deliberately paranoid.
//
//   DEFAULT (live !== true): fill the in-memory paper broker. The injected
//   placeEquityOrder function is not called. Setting ALLOW_LIVE_TRADING does
//   not change this — live must also be turned on.
//
//   LIVE order path: throws unless the process environment is exactly
//   ALLOW_LIVE_TRADING=I_UNDERSTAND. Any other value, including unset, refuses
//   before a broker function can run. Behind that latch the original gates
//   still apply:
//     - a BUY must arrive already approved (action.approved === true);
//     - shorting is refused (cash-only account);
//     - a missing broker function or account number refuses rather than guessing.
//
// The broker itself is injected (`placeEquityOrder`), so this module never
// imports or hard-codes any MCP tool and never reads credentials. Nothing here
// places a real order on its own.

import { randomUUID } from "node:crypto";
import { createPaperBroker } from "./paper-broker.mjs";

export const LIVE_TRADING_ENV = "ALLOW_LIVE_TRADING";
export const LIVE_TRADING_PHRASE = "I_UNDERSTAND";

// True only when the environment carries the exact arming phrase.
// Anything else — unset, "true", "1", "yes", a different case — is locked.
export function liveTradingArmed(env = process.env) {
  return env?.[LIVE_TRADING_ENV] === LIVE_TRADING_PHRASE;
}

export function createRobinhoodExecutor(opts = {}) {
  const {
    placeEquityOrder,            // async ({account_number, symbol, side, ...}) => order
                                 // LIVE hook only. Never called unless armed.
    accountNumber = null,        // required when live
    live = false,                // DEFAULT OFF — paper broker unless explicitly armed
    entryType = "limit",         // buys rest as a limit at the signal entry
    exitType = "market",         // exits/scale-outs close at market
    timeInForce = "gtc",
    marketHours = "regular_hours",
    log = () => {},
    audit = null,                // optional decision-log to record every send/withhold
    paper: paperOpt,
  } = opts;

  // Default venue is always an in-memory book. If the caller hands back the
  // injected live hook as `paper`, ignore it and keep the local broker.
  const paper = paperOpt && paperOpt.placeEquityOrder !== placeEquityOrder
    ? paperOpt
    : createPaperBroker(opts.paperOptions);

  const record = (rec) => { try { audit?.append?.({ source: "robinhood-exec", ...rec }); } catch {} };

  async function execute(action) {
    const mapped = buildOrder(action, { accountNumber, entryType, exitType, timeInForce, marketHours });

    // Default venue. The injected live hook is not in this branch.
    if (!live) {
      return fillPaper(action, mapped);
    }

    // ---- Live order path. Locked unless the arming phrase is set. ----
    if (!liveTradingArmed()) {
      const err = new Error(
        `Refusing to place a live order for ${action?.symbol || "?"}: ` +
        `${LIVE_TRADING_ENV} must be exactly ${LIVE_TRADING_PHRASE}. ` +
        `placeEquityOrder was not called.`
      );
      err.code = "LIVE_TRADING_LOCKED";
      err.name = "LiveTradingLockedError";
      record({ kind: "REFUSED_LIVE_LOCKED", live: false, ...flat(action, mapped) });
      throw err;
    }

    // A buy must be approved. Defense-in-depth with the loop's gate.
    if (isBuy(action) && action.approved !== true) {
      log(`REFUSED unapproved buy ${action.symbol} — no order sent`);
      record({ kind: "REFUSED_UNAPPROVED", live: true, ...flat(action, mapped) });
      return { placed: false, blocked: "unapproved-buy" };
    }

    // No shorting in a cash account.
    if (action.type === "ENTER" && action.side === "SHORT") {
      log(`REFUSED short entry ${action.symbol} — cash account cannot short`);
      record({ kind: "REFUSED_SHORT", live: true, ...flat(action, mapped) });
      return { placed: false, blocked: "short-not-allowed" };
    }

    if (typeof placeEquityOrder !== "function")
      return { placed: false, blocked: "no-broker-wired" };
    if (!accountNumber)
      return { placed: false, blocked: "no-account-number" };

    // Armed, approved, non-short: the only line that reaches the injected broker.
    const res = await placeEquityOrder(mapped);
    log(`SENT ${describe(mapped)} (ref ${mapped.ref_id})`);
    record({ kind: "SENT", live: true, ref_id: mapped.ref_id, ...flat(action, mapped) });
    return { placed: true, order: mapped, result: res };
  }

  async function fillPaper(action, mapped) {
    // Cash account: do not simulate an opening short, and do not touch the
    // live hook while refusing it.
    if (action?.type === "ENTER" && action?.side === "SHORT") {
      log(`REFUSED short entry ${action?.symbol} — paper book is long-only`);
      record({ kind: "REFUSED_SHORT", live: false, paper: true, ...flat(action, mapped) });
      return { placed: false, paper: true, dryRun: true, blocked: "short-not-allowed", wouldSend: mapped };
    }

    const paperOrder = { ...mapped };
    const px = mapped.limit_price ?? action?.price ?? action?.entry;
    if (px != null && px !== "") paperOrder.fill_price = String(px);

    const fill = await paper.placeEquityOrder(paperOrder);
    if (!fill || fill.state !== "filled") {
      const reason = fill?.reason || "paper-rejected";
      log(`[paper] rejected ${describe(mapped)} (${reason})`);
      record({ kind: "PAPER_REJECTED", live: false, paper: true, reason, ...flat(action, mapped) });
      return { placed: false, paper: true, dryRun: true, blocked: reason, wouldSend: mapped };
    }

    const price = Number(fill.fill_price);
    log(`[paper] filled ${describe(mapped)} @ ${fill.fill_price}`);
    record({
      kind: "PAPER_FILL",
      live: false,
      paper: true,
      symbol: action.symbol,
      type: action.type,
      side: action.side,
      shares: Number(action.shares),
      price,
      entry: action.type === "ENTER" ? price : action.entry,
      order_side: mapped.side,
      order_type: mapped.type,
      pnl: fill.realizedPnl,
      approved: action.approved === true,
      placed: false,
    });
    return { placed: false, paper: true, dryRun: true, wouldSend: mapped, fill };
  }

  return { execute, live, accountNumber, paper };
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
  return { symbol: action?.symbol, type: action?.type, side: action?.side,
    shares: action?.shares, approved: action?.approved === true,
    order_side: mapped.side, order_type: mapped.type };
}
