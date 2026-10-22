// risk-guard.js
// Portfolio-level circuit breakers that sit ABOVE the per-trade strategy. The
// strategy decides *what* to trade; the guard decides whether trading is allowed
// AT ALL right now. This is the layer that stops a bad day from becoming a bad
// week. Pure logic + a small serialisable state object so it can be persisted
// between loop runs (see loadState/saveState in the runner).
//
// Every limit is a hard number. When any is breached, canTrade() returns
// {ok:false} and the loop must not place orders — no override.

export function defaultConfig(equity = 1000) {
  return {
    dailyLossCapPct: 0.03,     // stop trading for the day after -3% of start equity
    maxDrawdownPct: 0.15,      // hard halt (kill) if equity falls 15% from peak
    riskPerTradePct: 0.01,     // 1% risk/trade (passed to the strategy)
    maxConcurrent: 3,          // at most 3 open positions at once
    maxTradesPerDay: 5,        // cap churn / overtrading
    maxPositionPct: 0.15,      // HOUSE RULE: no single NAME over 15% of the book
    maxNotionalPct: 0.34,      // absolute ceiling (dominated by maxPositionPct)
    minCashPct: 0.30,          // CASH FLOOR: always keep >= 30% of the book in cash
    minEquity: equity * 0.5,   // refuse to trade the account below half its start
  };
}

// A fresh state object. `day` is an ISO date string (YYYY-MM-DD) so we can detect
// day rollover and reset the daily counters.
export function newState(equity, day = today()) {
  return {
    day,
    startOfDayEquity: equity,
    peakEquity: equity,
    realizedPnLToday: 0,
    tradesToday: 0,
    openPositions: [],   // [{symbol, side, shares, entry, stop, riskDollars}]
    killSwitch: false,   // manual or auto hard-stop; blocks all trading until cleared
    haltedReason: null,
  };
}

// Roll the day over if the date changed: reset daily counters, re-anchor
// start-of-day equity. Open positions and the kill switch persist across days.
export function rollDay(state, equity, day = today()) {
  if (state.day === day) return state;
  return {
    ...state,
    day,
    startOfDayEquity: equity,
    realizedPnLToday: 0,
    tradesToday: 0,
    peakEquity: Math.max(state.peakEquity, equity),
  };
}

// The gate the loop checks before every candidate order.
// Returns { ok, reason, hard? }. equity = current mark-to-market account value.
// `hard: true` means an account-wide halt — the loop should stop scanning this
// cycle entirely, not just skip this one name.
//
// candidate may carry:
//   symbol     — the name being considered
//   notional   — $ value of the proposed position (shares * price)
//   cash       — current spendable cash (enables the 30% cash-floor check)
//   heldValue  — $ already held in this same name (for a top-up; usually 0)
export function canTrade(state, cfg, equity, candidate = {}) {
  // ---- Account-wide HARD halts (stop everything) -------------------------
  if (state.killSwitch)
    return no(`KILL SWITCH engaged${state.haltedReason ? `: ${state.haltedReason}` : ""}. Clear it manually to resume.`, true);

  const peak = Math.max(state.peakEquity, equity);
  const ddPct = peak > 0 ? (peak - equity) / peak : 0;
  if (ddPct >= cfg.maxDrawdownPct)
    return no(`Max drawdown breached: down ${(ddPct * 100).toFixed(1)}% from peak (limit ${(cfg.maxDrawdownPct * 100)}%). Auto-halt.`, true);

  if (equity < cfg.minEquity)
    return no(`Equity $${equity.toFixed(0)} below floor $${cfg.minEquity.toFixed(0)}. Trading disabled to preserve capital.`, true);

  // Daily max-loss kill switch: down >= 3% on the day halts ALL new buys.
  const dayLossPct = state.startOfDayEquity > 0
    ? (state.startOfDayEquity - equity) / state.startOfDayEquity : 0;
  if (dayLossPct >= cfg.dailyLossCapPct)
    return no(`Daily loss cap hit: down ${(dayLossPct * 100).toFixed(1)}% today (cap ${(cfg.dailyLossCapPct * 100)}%). Done for the day.`, true);

  if (state.tradesToday >= cfg.maxTradesPerDay)
    return no(`Max ${cfg.maxTradesPerDay} trades/day reached. Overtrading guard.`, true);

  if (state.openPositions.length >= cfg.maxConcurrent)
    return no(`Max ${cfg.maxConcurrent} concurrent positions open.`, true);

  // ---- Per-candidate SOFT skips (this name only) -------------------------
  if (candidate.symbol && state.openPositions.some((p) => p.symbol === candidate.symbol))
    return no(`Already hold ${candidate.symbol} — no pyramiding.`, false);

  if (candidate.notional != null) {
    const held = candidate.heldValue || 0;
    const nameTotal = candidate.notional + held;
    // 15%-per-name house rule (counts anything already held in the name).
    if (nameTotal > cfg.maxPositionPct * equity)
      return no(`${candidate.symbol || "Position"} would be $${nameTotal.toFixed(0)} = ` +
        `${((nameTotal / equity) * 100).toFixed(1)}% of the $${equity.toFixed(0)} book, over the ` +
        `${Math.round(cfg.maxPositionPct * 100)}% per-name cap.`, false);
    // Absolute ceiling (legacy; normally dominated by the per-name cap).
    if (nameTotal > cfg.maxNotionalPct * equity)
      return no(`${candidate.symbol || "Position"} $${nameTotal.toFixed(0)} exceeds ${Math.round(cfg.maxNotionalPct * 100)}% of the $${equity.toFixed(0)} book.`, false);

    // 30% cash floor: a buy may not drag spendable cash below the floor.
    if (candidate.cash != null) {
      const cashAfter = candidate.cash - candidate.notional;
      const floor = cfg.minCashPct * equity;
      if (cashAfter < floor - 1e-6)
        return no(`Buying $${candidate.notional.toFixed(0)} would leave $${cashAfter.toFixed(0)} cash, ` +
          `under the ${Math.round(cfg.minCashPct * 100)}% floor ($${floor.toFixed(0)}). Trade blocked.`, false);
    }
  }

  return { ok: true, reason: "All risk gates clear.", hard: false };
}

// Mutating helpers the loop calls when it actually fills / closes a trade.
export function recordEntry(state, pos) {
  state.openPositions.push(pos);
  state.tradesToday += 1;
  return state;
}

export function recordExit(state, symbol, realizedPnL) {
  state.openPositions = state.openPositions.filter((p) => p.symbol !== symbol);
  state.realizedPnLToday += realizedPnL;
  return state;
}

// Auto-trip the kill switch (called by the loop on repeated errors, data gaps,
// or a manual command). Once tripped, canTrade blocks everything until cleared.
export function trip(state, reason) {
  state.killSwitch = true;
  state.haltedReason = reason;
  return state;
}
export function clearKill(state) {
  state.killSwitch = false;
  state.haltedReason = null;
  return state;
}

// Ratchet the high-water mark on every fresh equity read. Without this the peak
// only updated on day rollover, so an intraday pump-then-dump understated the
// drawdown the kill switch measures against. Call once per cycle with live equity.
export function markEquity(state, equity) {
  if (typeof equity === "number" && equity > (state.peakEquity ?? -Infinity))
    state.peakEquity = equity;
  return state;
}

function no(reason, hard = false) { return { ok: false, reason, hard }; }
function today() { return new Date().toISOString().slice(0, 10); }
