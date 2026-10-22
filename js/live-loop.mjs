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
// SAFETY RAILS (all enforced here, belt-and-suspenders with risk-guard):
//   - dryRun      : defaults ON. While ON, NOTHING is ever sent to execute(),
//                   regardless of mode. A new strategy is paper-only until a human
//                   explicitly sets dryRun:false.
//   - mode        : "propose" (default) never executes; "execute" may, but only
//                   when dryRun is false.
//   - approval    : every BUY requires an explicit human yes via deps.approve().
//                   No approver, or a falsy answer => the buy stays a proposal.
//                   (Exits/scale-outs are risk-REDUCING and do not need approval.)
//   - decisionLog : every decision — placed, proposed, skipped, blocked — is
//                   appended to an append-only audit log.
//
// deps = {
//   fetchCandles(symbol, timeframe) -> [{time,open,high,low,close,volume}]
//        timeframe ∈ "entry" | "daily" | "weekly"
//   getEquity() -> number            (current account value)
//   getCash()   -> number            (optional; enables the 30% cash floor)
//   execute({type, ...}) -> any       (called only when actually placing)
//   approve(action) -> boolean|Promise (optional; REQUIRED to place a buy)
//   decisionLog -> { append(rec) }    (optional; append-only audit log)
//   log(msg)                          (optional human-readable trace)
// }

import { evaluateMTF } from "./mtf.js";
import * as guard from "./risk-guard.js";
import { managePosition, checkScaleOut } from "./trade-manager.js";
import { nullLog } from "./decision-log.mjs";

export async function runCycle(deps, watchlist, state, cfg, opts = {}) {
  const mode = opts.mode ?? "propose";
  // dryRun defaults ON. It is only off when EXPLICITLY set to false.
  const dryRun = opts.dryRun === false ? false : (cfg?.dryRun === false ? false : true);
  const canPlace = mode === "execute" && !dryRun;  // hard gate for any execute()
  const log = deps.log || (() => {});
  const audit = deps.decisionLog || nullLog();
  const cycleId = opts.cycleId || new Date().toISOString();
  // The signal engine is injectable so the loop's safety rails can be tested in
  // isolation. Defaults to the real multi-timeframe strategy.
  const evalFn = opts.evaluate || evaluateMTF;
  const actions = [];

  const equity = await deps.getEquity();
  const cash = deps.getCash ? await deps.getCash() : null;
  guard.markEquity(state, equity);          // ratchet high-water mark
  state = guard.rollDay(state, equity);

  const record = (rec) => {
    const full = { cycle: cycleId, mode, dryRun, ...rec };
    audit.append(full);
    return full;
  };

  // ---- 1. Manage open positions -------------------------------------------
  // Exits and scale-outs REDUCE risk, so they are allowed to execute without a
  // fresh approval (dryRun still blocks them in paper mode).
  for (const pos of [...state.openPositions]) {
    const entryCandles = await deps.fetchCandles(pos.symbol, "entry");
    if (!entryCandles?.length) continue;
    const last = entryCandles[entryCandles.length - 1];
    const long = pos.side === "LONG";

    // (a) scale-out — take partial profit, let the rest run on the trail
    const so = checkScaleOut(pos, last, opts.mgmt);
    if (so && so.shares > 0) {
      const act = { type: "SCALE_OUT", symbol: pos.symbol, side: pos.side, shares: so.shares,
        price: so.price, reason: so.reason };
      actions.push(act);
      record({ kind: "SCALE_OUT", symbol: pos.symbol, side: pos.side, shares: so.shares,
        price: so.price, reason: so.reason, approved: true, placed: canPlace });
      if (canPlace) {
        act.approved = true; // risk-reducing sell — auto-approved
        await deps.execute(act);
        pos.shares -= so.shares; pos.scaledOut = true; pos.target = null;
      }
      log(`SCALE_OUT ${pos.symbol} ${so.shares} @ ${so.price} (${so.reason})${canPlace ? "" : " [paper]"}`);
    }

    // (b) exit remainder on stop (as ratcheted) or fixed target
    const hitStop = long ? last.low <= pos.stop : last.high >= pos.stop;
    const hitTgt = pos.target != null && (long ? last.high >= pos.target : last.low <= pos.target);
    if (hitStop || hitTgt) {
      const exitPrice = hitStop ? pos.stop : pos.target;
      const pnl = long ? (exitPrice - pos.entry) * pos.shares : (pos.entry - exitPrice) * pos.shares;
      const act = { type: "EXIT", symbol: pos.symbol, side: pos.side, shares: pos.shares,
        price: exitPrice, reason: hitStop ? (pos.beMoved ? "trail/BE stop" : "stop") : "target", pnl: round(pnl) };
      actions.push(act);
      record({ kind: "EXIT", symbol: pos.symbol, side: pos.side, shares: pos.shares,
        price: exitPrice, reason: act.reason, pnl: act.pnl, approved: true, placed: canPlace });
      if (canPlace) { act.approved = true; await deps.execute(act); guard.recordExit(state, pos.symbol, pnl); }
      log(`EXIT ${pos.symbol} @ ${exitPrice} (${act.reason}) pnl ${act.pnl}${canPlace ? "" : " [paper]"}`);
      continue;
    }

    // (c) ratchet the stop for next cycle
    const mg = managePosition(pos, entryCandles, opts.mgmt);
    for (const a of mg.actions) log(`  ${pos.symbol}: ${a.reason} → stop ${a.to}`);
  }

  // ---- 2. Scan for new entries --------------------------------------------
  for (const symbol of watchlist) {
    const pre = guard.canTrade(state, cfg, equity, { symbol, cash });
    if (!pre.ok) {
      record({ kind: "SKIP", symbol, reason: pre.reason, approved: false, placed: false });
      log(`skip ${symbol}: ${pre.reason}`);
      if (pre.hard) break; else continue;
    }

    const [entry, daily, weekly] = await Promise.all([
      deps.fetchCandles(symbol, "entry"),
      deps.fetchCandles(symbol, "daily"),
      deps.fetchCandles(symbol, "weekly"),
    ]);
    const sig = await evalFn({ entry, daily, weekly },
      equity, { riskPct: cfg.riskPerTradePct, maxPositionPct: cfg.maxPositionPct, ...opts.strategy });
    if (sig.action === "NO_TRADE") {
      record({ kind: "NO_TRADE", symbol, reason: sig.reason, approved: false, placed: false });
      log(`${symbol}: ${sig.reason}`);
      continue;
    }

    // Re-check the guard now that we know the position's notional and cash impact.
    const heldValue = valueHeld(state, symbol, sig.entry);
    const gate = guard.canTrade(state, cfg, equity, { symbol, notional: sig.notional, cash, heldValue });
    if (!gate.ok) {
      record({ kind: "BLOCKED", symbol, side: sig.action, shares: sig.shares, entry: sig.entry,
        notional: sig.notional, reason: gate.reason, approved: false, placed: false });
      log(`${symbol} blocked by guard: ${gate.reason}`);
      if (gate.hard) break; else continue;
    }

    const act = { type: "ENTER", symbol, side: sig.action === "BUY" ? "LONG" : "SHORT",
      shares: sig.shares, entry: sig.entry, stop: sig.stop, target: sig.target,
      riskDollars: sig.riskDollars, confidence: sig.confidence, setup: sig.setup, plan: sig.plan };
    actions.push(act);

    // --- Human approval gate: NO buy executes without an explicit yes. -------
    let approved = false;
    if (canPlace) {
      if (typeof deps.approve === "function") {
        try { approved = !!(await deps.approve(act)); }
        catch (e) { approved = false; log(`approval error for ${symbol}: ${e?.message || e}`); }
      } else {
        approved = false; // execute mode but no approver wired => never auto-buy
      }
    }

    record({ kind: "ENTER", symbol, side: act.side, shares: act.shares, entry: act.entry,
      stop: act.stop, target: act.target, notional: sig.notional, confidence: act.confidence,
      setup: act.setup, reason: act.plan, approved, placed: approved });

    if (approved) {
      act.approved = true; // human said yes — stamp it so the executor can verify
      await deps.execute(act);
      guard.recordEntry(state, { symbol, side: act.side, shares: act.shares,
        entry: act.entry, stop: act.stop, initialStop: act.stop,
        riskPerShare: Math.abs(act.entry - act.stop), target: act.target,
        riskDollars: act.riskDollars, beMoved: false, scaledOut: false });
      log(`ENTER ${symbol} (APPROVED): ${sig.plan}`);
    } else {
      act.status = canPlace ? "AWAITING_APPROVAL" : "PROPOSED";
      log(`PROPOSE ${symbol}${canPlace ? " (needs approval)" : " [paper]"}: ${sig.plan}`);
    }
  }

  return { actions, state, equity, cash, mode, dryRun };
}

// $ already held in `symbol` at the given mark price (0 if flat). Lets the
// per-name cap count an existing holding when a top-up is considered.
function valueHeld(state, symbol, price) {
  const p = state.openPositions.find((x) => x.symbol === symbol);
  return p ? Math.abs(p.shares) * (price || p.entry || 0) : 0;
}

function round(v) { return Math.round(v * 100) / 100; }
