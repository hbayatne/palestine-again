// live-loop.mjs
// One cycle of the live trading loop, dependency-injected so the SAME logic runs
// against synthetic data here (testable) and against the real Robinhood MCP tools
// in your authenticated session. The loop never talks to a broker directly — it
// calls the `fetchCandles` and `execute` functions you hand it. That keeps the
// decision logic pure and the broker wiring swappable.
//
// A cycle does two things, in this order:
//   1. MANAGE open positions — check each against its stop/target on fresh data.
//   2. SCAN the watchlist — multi-timeframe evaluate, risk-guard, then propose or
//      place new entries until a guard says stop.
//
// mode:
//   "propose"  (default, SAFE) — never places an order; returns a list of
//              intended actions for a human to approve. Start here.
//   "execute"  — actually calls execute() for fills/exits. Only flip to this
//              after a forward-tested track record.

import { evaluateMTF } from "./mtf.js";
import * as guard from "./risk-guard.js";

// deps = {
//   fetchCandles(symbol, timeframe) -> [{time,open,high,low,close,volume}]
//        timeframe ∈ "entry" | "daily" | "weekly"
//   getEquity() -> number   (current account value)
//   execute({type, ...})    -> called only in "execute" mode
//   log(msg)                (optional)
// }
export async function runCycle(deps, watchlist, state, cfg, opts = {}) {
  const mode = opts.mode ?? "propose";
  const log = deps.log || (() => {});
  const actions = [];

  const equity = await deps.getEquity();
  state = guard.rollDay(state, equity);

  // ---- 1. Manage open positions -------------------------------------------
  for (const pos of [...state.openPositions]) {
    const entryCandles = await deps.fetchCandles(pos.symbol, "entry");
    if (!entryCandles?.length) continue;
    const last = entryCandles[entryCandles.length - 1];
    const hitStop = pos.side === "LONG" ? last.low <= pos.stop : last.high >= pos.stop;
    const hitTgt = pos.side === "LONG" ? last.high >= pos.target : last.low <= pos.target;
    if (hitStop || hitTgt) {
      const exitPrice = hitStop ? pos.stop : pos.target;
      const pnl = pos.side === "LONG"
        ? (exitPrice - pos.entry) * pos.shares
        : (pos.entry - exitPrice) * pos.shares;
      const act = { type: "EXIT", symbol: pos.symbol, side: pos.side, shares: pos.shares,
        price: exitPrice, reason: hitStop ? "stop" : "target", pnl: round(pnl) };
      actions.push(act);
      if (mode === "execute") { await deps.execute(act); guard.recordExit(state, pos.symbol, pnl); }
      log(`EXIT ${pos.symbol} @ ${exitPrice} (${act.reason}) pnl ${act.pnl}`);
    }
  }

  // ---- 2. Scan for new entries --------------------------------------------
  for (const symbol of watchlist) {
    const pre = guard.canTrade(state, cfg, equity, { symbol });
    if (!pre.ok) { log(`skip ${symbol}: ${pre.reason}`); if (isHardHalt(pre.reason)) break; else continue; }

    const [entry, daily, weekly] = await Promise.all([
      deps.fetchCandles(symbol, "entry"),
      deps.fetchCandles(symbol, "daily"),
      deps.fetchCandles(symbol, "weekly"),
    ]);
    const sig = evaluateMTF({ entry, daily, weekly },
      equity, { riskPct: cfg.riskPerTradePct, ...opts.strategy });
    if (sig.action === "NO_TRADE") { log(`${symbol}: ${sig.reason}`); continue; }

    // Re-check the guard now that we know the position's notional.
    const gate = guard.canTrade(state, cfg, equity, { symbol, notional: sig.notional });
    if (!gate.ok) { log(`${symbol} blocked by guard: ${gate.reason}`); if (isHardHalt(gate.reason)) break; else continue; }

    const act = { type: "ENTER", symbol, side: sig.action === "BUY" ? "LONG" : "SHORT",
      shares: sig.shares, entry: sig.entry, stop: sig.stop, target: sig.target,
      riskDollars: sig.riskDollars, confidence: sig.confidence, setup: sig.setup, plan: sig.plan };
    actions.push(act);
    if (mode === "execute") {
      await deps.execute(act);
      guard.recordEntry(state, { symbol, side: act.side, shares: act.shares,
        entry: act.entry, stop: act.stop, target: act.target, riskDollars: act.riskDollars });
    }
    log(`ENTER ${symbol}: ${sig.plan}`);
  }

  return { actions, state, equity, mode };
}

function isHardHalt(reason) {
  return /KILL SWITCH|Max drawdown|below floor|Daily loss cap|trades\/day/.test(reason);
}
function round(v) { return Math.round(v * 100) / 100; }
