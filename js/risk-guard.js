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
    maxNotionalPct: 0.34,      // no single position over ~1/3 of the book
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
// Returns { ok, reason }. equity = current mark-to-market account value.
export function canTrade(state, cfg, equity, candidate = {}) {
  if (state.killSwitch)
    return no(`KILL SWITCH engaged${state.haltedReason ? `: ${state.haltedReason}` : ""}. Clear it manually to resume.`);

  const peak = Math.max(state.peakEquity, equity);
  const ddPct = (peak - equity) / peak;
  if (ddPct >= cfg.maxDrawdownPct)
    return no(`Max drawdown breached: down ${(ddPct * 100).toFixed(1)}% from peak (limit ${(cfg.maxDrawdownPct * 100)}%). Auto-halt.`);

  if (equity < cfg.minEquity)
    return no(`Equity $${equity.toFixed(0)} below floor $${cfg.minEquity.toFixed(0)}. Trading disabled to preserve capital.`);

  const dayLossPct = (state.startOfDayEquity - equity) / state.startOfDayEquity;
  if (dayLossPct >= cfg.dailyLossCapPct)
    return no(`Daily loss cap hit: down ${(dayLossPct * 100).toFixed(1)}% today (cap ${(cfg.dailyLossCapPct * 100)}%). Done for the day.`);

  if (state.tradesToday >= cfg.maxTradesPerDay)
    return no(`Max ${cfg.maxTradesPerDay} trades/day reached. Overtrading guard.`);

  if (state.openPositions.length >= cfg.maxConcurrent)
    return no(`Max ${cfg.maxConcurrent} concurrent positions open.`);

  if (candidate.symbol && state.openPositions.some((p) => p.symbol === candidate.symbol))
    return no(`Already hold ${candidate.symbol} — no pyramiding.`);

  if (candidate.notional != null && candidate.notional > cfg.maxNotionalPct * equity)
    return no(`Position $${candidate.notional.toFixed(0)} exceeds ${Math.round(cfg.maxNotionalPct * 100)}% of the $${equity.toFixed(0)} book.`);

  return { ok: true, reason: "All risk gates clear." };
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

function no(reason) { return { ok: false, reason }; }
function today() { return new Date().toISOString().slice(0, 10); }
