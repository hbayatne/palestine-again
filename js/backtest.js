// backtest.js
// Walk-forward simulator for the breakout / structure strategy. It replays
// candles one bar at a time, only ever letting the strategy see the past, opens
// the trade on the NEXT bar's open (no look-ahead), then manages the stop and
// target bar-by-bar. Output is the honest scorecard: win rate, expectancy in R,
// profit factor, max drawdown, average hold. This is where you find out whether
// "obvious breakouts" actually pay after costs — before risking a real dollar.

import { evaluate } from "./strategy.js";

// candles: full OHLCV array. opts passes through to the strategy plus:
//   warmup       — bars to skip before trading (indicator/pivot burn-in)
//   feePct       — round-trip cost estimate per trade (commission+slippage)
//   equity       — starting equity for position sizing
//   oneAtATime   — if true, no new entry while a trade is open (default true)
export function backtest(candles, opts = {}) {
  const warmup = opts.warmup ?? 60;
  const feePct = opts.feePct ?? 0.001; // 0.1% round-trip default
  let equity = opts.equity ?? 1000;
  const oneAtATime = opts.oneAtATime ?? true;

  const trades = [];
  let open = null; // { side, entry, stop, target, shares, entryIdx }
  let peakEquity = equity;
  let maxDD = 0;

  for (let i = warmup; i < candles.length - 1; i++) {
    const bar = candles[i];
    const next = candles[i + 1];

    // 1) manage an open trade against THIS bar's range
    if (open) {
      const hitStop = open.side === "LONG" ? bar.low <= open.stop : bar.high >= open.stop;
      const hitTgt = open.side === "LONG" ? bar.high >= open.target : bar.low <= open.target;
      // conservative: if both hit in one bar, assume stop first (worst case)
      let exit = null, outcome = null;
      if (hitStop) { exit = open.stop; outcome = "stop"; }
      else if (hitTgt) { exit = open.target; outcome = "target"; }
      if (exit != null) {
        const gross = open.side === "LONG"
          ? (exit - open.entry) * open.shares
          : (open.entry - exit) * open.shares;
        const fees = (open.entry + exit) * open.shares * feePct;
        const pnl = gross - fees;
        equity += pnl;
        const rMultiple = pnl / (open.riskDollars || 1);
        trades.push({ ...open, exit, outcome, pnl: round(pnl), rMultiple: round(rMultiple),
          bars: i - open.entryIdx, exitIdx: i });
        peakEquity = Math.max(peakEquity, equity);
        maxDD = Math.max(maxDD, (peakEquity - equity) / peakEquity);
        open = null;
      }
    }

    // 2) look for a new entry (only on past data up to and including bar i)
    if (!open || !oneAtATime) {
      if (open) continue;
      const view = candles.slice(0, i + 1);
      const sig = evaluate(view, equity, opts);
      if (sig.action === "BUY" || sig.action === "SELL_SHORT") {
        const side = sig.action === "BUY" ? "LONG" : "SHORT";
        const entry = next.open; // fill on next bar's open — no look-ahead
        open = {
          side, entry: round(entry), stop: sig.stop, target: sig.target,
          shares: sig.shares, riskDollars: sig.riskDollars, setup: sig.setup,
          entryIdx: i + 1, confidence: sig.confidence,
        };
      }
    }
  }

  return summarize(trades, opts.equity ?? 1000, equity, maxDD);
}

function summarize(trades, startEq, endEq, maxDD) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const rSum = trades.reduce((a, t) => a + t.rMultiple, 0);
  const n = trades.length;
  return {
    trades: n,
    winRate: n ? round((wins.length / n) * 100) : 0,
    expectancyR: n ? round(rSum / n) : 0,        // avg R per trade — the key number
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : (grossWin > 0 ? Infinity : 0),
    avgWin: wins.length ? round(grossWin / wins.length) : 0,
    avgLoss: losses.length ? round(-grossLoss / losses.length) : 0,
    avgBarsHeld: n ? round(trades.reduce((a, t) => a + t.bars, 0) / n) : 0,
    maxDrawdownPct: round(maxDD * 100),
    startEquity: round(startEq),
    endEquity: round(endEq),
    returnPct: round(((endEq - startEq) / startEq) * 100),
    tradeLog: trades,
  };
}

function round(v) { return v == null ? null : Math.round(v * 100) / 100; }
